#!/usr/bin/env python3
"""Throughline local memory service: SQLite FTS5 + bge-small int8 vectors + hybrid search.

Modes:
  python memory.py init   --db PATH
  python memory.py add    --db PATH --jsonl FILE [--status PATH]
  python memory.py search --db PATH --query "..." [--budget 3000]
  python memory.py stats  --db PATH
  python memory.py serve  --db PATH        # JSON-lines over stdin/stdout (persistent)

Storage: text + FTS5 live in SQLite; vectors live in fixed-capacity bucket files
(`<db stem>.buckets/bucket-NNNN.npz`, 2048 turns each) described by `manifest.json`.
Append-only buckets keep ingestion incremental: a new run only rewrites the open
tail bucket, and the number of buckets follows the corpus size instead of being
configured. `serve` reloads when the manifest changes, so writers that finish
after the service started are visible on the next query.

Search = 0.7*z(dense) + 0.3*z(BM25), greedily filled to a token budget. If the ONNX
model is missing, search degrades to BM25 only.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import sqlite3
import sys
import time

SERVICE_DIR = pathlib.Path(__file__).resolve().parent
# bundled wheels/packages take precedence when present
_vendor = SERVICE_DIR / "vendor"
if _vendor.exists():
    sys.path.insert(0, str(_vendor))

import numpy as np  # noqa: E402

for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

DEFAULT_MODEL_DIR = SERVICE_DIR / "model"

# A model directory may carry `model.json` describing non-BGE conventions:
# { "name", "pooling": "mean"|"cls", "queryPrefix", "docPrefix", "maxTokens" }.
# Without it the BGE defaults below apply.
DEFAULT_SPEC = {
    "name": "bge-small-en-v1.5",
    "pooling": "cls",
    "queryPrefix": "Represent this sentence for searching relevant passages: ",
    "docPrefix": "Represent this sentence for searching relevant passages: ",
    "maxTokens": 254,
}
WIN = 254
WORD = re.compile(r"[a-zA-Z0-9_]+")
CJK_RUN = re.compile(r"[\u4e00-\u9fff]+")

# One bucket = one .npz rewrite. 2048 turns is ~3.1 MB at dim 384 float32.
BUCKET_CAP = int(os.environ.get("THROUGHLINE_BUCKET_CAP", "2048"))

# Human-maintained layers (both optional, both file-backed):
#   pinned.md    one fact per line, `- ` prefix; ingested under session "pinned"
#   glossary.json  { "中文术语": ["english", "synonym"] } used to expand queries
PINNED_SESSION = "pinned"
PINNED_BOOST = 0.8

REDACTION_FILE = SERVICE_DIR / "redaction.json"


def _load_redactors():
    """Credential patterns shared with the extractor (single source of truth)."""
    try:
        raw = json.loads(REDACTION_FILE.read_text(encoding="utf-8"))
        out = []
        for item in raw.get("patterns", []):
            flags = re.I if "i" in str(item.get("flags", "")) else 0
            out.append(re.compile(item["regex"], flags))
        return out
    except Exception:
        return []


REDACTORS = _load_redactors()


def redact(text):
    """Strip credential-shaped substrings before they reach storage."""
    out, count = str(text), 0
    for pattern in REDACTORS:
        out, n = pattern.subn("[REDACTED]", out)
        count += n
    return out, count


def est_tok(s):
    return max(1, len(str(s)) // 4)


def tokens(s):
    """Index/query terms: latin words plus CJK character bigrams and unigrams.

    CJK has no whitespace, so the default FTS5 tokenizer yields nothing useful
    for it. Character bigrams are the long-standing lexical baseline for
    Chinese retrieval (they beat word segmentation in BM25 experiments), and
    they need no dictionary, so the same function runs at index and query time.
    """
    text = str(s)
    out = [w.lower() for w in WORD.findall(text)]
    for run in CJK_RUN.findall(text):
        out.extend(run[i:i + 2] for i in range(len(run) - 1))
        out.extend(run)
    return [t for t in out if t]


def db_paths(db):
    db = pathlib.Path(db).resolve()
    return db, db.parent / (db.stem + ".vectors.npy"), db.parent / (db.stem + ".ids.npy")


def bucket_dir(db):
    db = pathlib.Path(db).resolve()
    return db.parent / (db.stem + ".buckets")


def manifest_path(db):
    return bucket_dir(db) / "manifest.json"


def load_manifest(db):
    p = manifest_path(db)
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def save_manifest(db, man):
    d = bucket_dir(db)
    d.mkdir(parents=True, exist_ok=True)
    p = manifest_path(db)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(man, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)


def write_status(path, obj):
    """Best-effort progress file for the host UI; never raises."""
    if not path:
        return
    try:
        p = pathlib.Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, p)
    except Exception:
        pass


def connect(db):
    dbp, _, _ = db_paths(db)
    dbp.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(dbp), check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    return con


def init_db(con):
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS turns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            turn_idx INTEGER NOT NULL,
            role TEXT,
            date TEXT,
            text TEXT NOT NULL,
            hash TEXT UNIQUE,
            vec BLOB,
            vec_ok INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(text);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        """
    )
    # Databases written by 0.1.x predate the bucket flag.
    cols = {r[1] for r in con.execute("PRAGMA table_info(turns)").fetchall()}
    if "vec_ok" not in cols:
        con.execute("ALTER TABLE turns ADD COLUMN vec_ok INTEGER NOT NULL DEFAULT 0")
    con.execute("CREATE INDEX IF NOT EXISTS idx_turns_vec_ok ON turns(vec_ok)")
    con.commit()


def load_glossary(store):
    try:
        raw = json.loads((pathlib.Path(store) / "glossary.json").read_text(encoding="utf-8"))
    except Exception:
        return {}
    out = {}
    for key, value in raw.items():
        terms = value if isinstance(value, list) else [value]
        terms = [str(t).strip() for t in terms if str(t).strip()]
        if key and terms:
            out[str(key)] = terms
    return out


def expand_query(query, glossary):
    if not glossary:
        return query
    extra = []
    for key, terms in glossary.items():
        if key in query:
            extra.extend(terms)
    if not extra:
        return query
    seen, uniq = set(), []
    for t in extra:
        if t not in seen:
            seen.add(t)
            uniq.append(t)
    return query + " " + " ".join(uniq[:12])


def load_spec(model_dir):
    spec = dict(DEFAULT_SPEC)
    try:
        raw = json.loads((pathlib.Path(model_dir) / "model.json").read_text(encoding="utf-8"))
        for key in ("name", "pooling", "queryPrefix", "docPrefix", "maxTokens"):
            if key in raw:
                spec[key] = raw[key]
    except Exception:
        pass
    return spec


LEX_VERSION = "1"


def ensure_lex(con):
    """Rebuild the FTS table when it predates CJK bigram tokenization."""
    row = con.execute("SELECT value FROM meta WHERE key='lex_version'").fetchone()
    if row and row[0] == LEX_VERSION:
        return 0
    n = con.execute("SELECT COUNT(*) FROM turns").fetchone()[0]
    if n:
        con.execute("DROP TABLE IF EXISTS turns_fts")
        con.execute("CREATE VIRTUAL TABLE turns_fts USING fts5(text)")
        for rid, text in con.execute("SELECT id,text FROM turns ORDER BY id").fetchall():
            con.execute("INSERT INTO turns_fts(rowid,text) VALUES(?,?)",
                        (rid, " ".join(tokens(text))))
    con.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('lex_version',?)",
                (LEX_VERSION,))
    con.commit()
    return n


class Encoder:
    def __init__(self, model_dir=None, threads=4):
        self.ok = False
        self.dir = pathlib.Path(model_dir) if model_dir else DEFAULT_MODEL_DIR
        self.spec = load_spec(self.dir)
        self.pooling = self.spec["pooling"]
        self.qprefix = self.spec["queryPrefix"]
        self.dprefix = self.spec["docPrefix"]
        self.max_tokens = int(self.spec["maxTokens"])
        try:
            from tokenizers import Tokenizer
            import onnxruntime as ort

            self.tk = Tokenizer.from_file(str(self.dir / "tokenizer.json"))
            # XLM-R style tokenizers (E5) use <s>/</s> instead of BERT's CLS/SEP.
            self.cls = self.tk.token_to_id("[CLS]")
            if self.cls is None:
                self.cls = self.tk.token_to_id("<s>") or 0
            self.sep = self.tk.token_to_id("[SEP]")
            if self.sep is None:
                self.sep = self.tk.token_to_id("</s>") or 2
            so = ort.SessionOptions()
            so.intra_op_num_threads = int(os.environ.get("THROUGHLINE_THREADS", threads))
            so.inter_op_num_threads = 1
            so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            self.sess = ort.InferenceSession(
                str(self.dir / "model_quantized.onnx"), so,
                providers=["CPUExecutionProvider"],
            )
            self._has_token_types = any(
                i.name == "token_type_ids" for i in self.sess.get_inputs())
            self.dim = int(self.sess.get_outputs()[0].shape[-1])
            self.ok = True
        except Exception as e:
            self.err = str(e)
            self.ok = False

    def embed(self, texts, batch=32, kind="doc"):
        if not self.ok or not texts:
            return None
        prefix = self.qprefix if kind == "query" else self.dprefix
        out = []
        for i in range(0, len(texts), batch):
            chunk = texts[i:i + batch]
            seqs = []
            for t in chunk:
                ids = self.tk.encode(prefix + str(t)).ids[1:-1] or [0]
                ids = ids[:self.max_tokens]
                seqs.append([self.cls] + ids + [self.sep])
            mx = max(len(x) for x in seqs)
            a = np.zeros((len(seqs), mx), dtype=np.int64)
            m = np.zeros((len(seqs), mx), dtype=np.int64)
            for j, x in enumerate(seqs):
                a[j, :len(x)] = x
                m[j, :len(x)] = 1
            feed = {"input_ids": a, "attention_mask": m}
            if self._has_token_types:
                feed["token_type_ids"] = np.zeros_like(a)
            hidden = self.sess.run(None, feed)[0]
            if self.pooling == "mean":
                mask = m[..., None].astype(np.float32)
                v = (hidden * mask).sum(axis=1) / np.maximum(mask.sum(axis=1), 1e-6)
            else:
                v = hidden[:, 0, :]
            v = v / np.linalg.norm(v, axis=1, keepdims=True)
            out.append(v.astype(np.float32))
        return np.concatenate(out, axis=0)


class Buckets:
    """Append-only vector buckets. Only the open tail bucket is buffered."""

    def __init__(self, db, dim=384):
        self.db = db
        self.dir = bucket_dir(db)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.dim = dim
        self.man = load_manifest(db) or {
            "version": 1, "dim": dim, "dtype": "float32",
            "cap": BUCKET_CAP, "count": 0, "buckets": [],
        }
        self.dim = int(self.man.get("dim") or dim)
        self.ids = np.empty(0, dtype=np.int64)
        self.mat = np.empty((0, self.dim), dtype=np.float32)
        self.slot = None  # index into man["buckets"] currently buffered
        last = self.man["buckets"][-1] if self.man["buckets"] else None
        if last and last["n"] < self.man["cap"]:
            try:
                with np.load(self.dir / last["file"], allow_pickle=False) as z:
                    self.ids = np.asarray(z["ids"], dtype=np.int64)
                    self.mat = np.asarray(z["mat"], dtype=np.float32)
                self.slot = len(self.man["buckets"]) - 1
            except Exception:
                self.ids = np.empty(0, dtype=np.int64)
                self.mat = np.empty((0, self.dim), dtype=np.float32)

    def append(self, pairs):
        """pairs: [(row_id, float32 vector)]; seals a bucket when it fills up."""
        if not pairs:
            return
        ids = np.asarray([p[0] for p in pairs], dtype=np.int64)
        mat = np.stack([np.asarray(p[1], dtype=np.float32) for p in pairs])
        while len(ids):
            space = self.man["cap"] - len(self.ids)
            if space <= 0:
                self._seal()
                space = self.man["cap"]
            take = min(space, len(ids))
            self.ids = np.concatenate([self.ids, ids[:take]])
            self.mat = np.vstack([self.mat, mat[:take]]) if len(self.mat) else mat[:take]
            ids, mat = ids[take:], mat[take:]
            self.man["count"] += take
            if len(self.ids) >= self.man["cap"]:
                self._seal()

    def _seal(self):
        if not len(self.ids):
            return
        if self.slot is None:
            self.man["buckets"].append({
                "file": f"bucket-{len(self.man['buckets']):04d}.npz", "n": 0,
            })
            self.slot = len(self.man["buckets"]) - 1
        entry = self.man["buckets"][self.slot]
        tmp = self.dir / (entry["file"] + ".tmp.npz")
        np.savez(tmp, ids=self.ids, mat=self.mat.astype(np.float32))
        os.replace(tmp, self.dir / entry["file"])
        entry["n"] = int(len(self.ids))
        entry["first_id"] = int(self.ids[0])
        entry["last_id"] = int(self.ids[-1])
        save_manifest(self.db, self.man)
        self.ids = np.empty(0, dtype=np.int64)
        self.mat = np.empty((0, self.dim), dtype=np.float32)
        self.slot = None

    def close(self):
        self._seal()
        save_manifest(self.db, self.man)
        return self.man["count"]


def import_legacy(con, db):
    """Move a 0.1.x single-matrix index into buckets (one-time migration)."""
    dbp, vpath, ipath = db_paths(db)
    if load_manifest(db) is not None or not (vpath.exists() and ipath.exists()):
        return 0
    try:
        ids = np.load(ipath)
        mat = np.load(vpath)
    except Exception:
        return 0
    w = Buckets(db)
    w.append([(int(i), mat[k]) for k, i in enumerate(ids)])
    w.close()
    con.execute("UPDATE turns SET vec_ok=1")
    con.commit()
    for p in (vpath, ipath):
        try:
            p.unlink()
        except Exception:
            pass
    return len(ids)


def compact_buckets(con, db):
    """Rewrite the bucket set to only the vectors still referenced by rows.

    Replace-by-session deletes rows and inserts new ids, so repeated ingests
    would otherwise accumulate orphan vectors in the append-only buckets.
    """
    man = load_manifest(db)
    if not man or not man.get("buckets"):
        return 0
    vectors = {}
    for entry in man["buckets"]:
        try:
            with np.load(bucket_dir(db) / entry["file"], allow_pickle=False) as z:
                for i, row in zip(z["ids"], z["mat"]):
                    vectors[int(i)] = row
        except Exception:
            continue
    live = [r[0] for r in con.execute(
        "SELECT id FROM turns WHERE vec_ok=1 ORDER BY id").fetchall()]
    keep = [(int(i), vectors[int(i)]) for i in live if int(i) in vectors]
    shutil.rmtree(bucket_dir(db), ignore_errors=True)
    if not keep:
        save_manifest(db, {"version": 1, "dim": man.get("dim", 384), "dtype": "float32",
                           "cap": man.get("cap", BUCKET_CAP), "count": 0, "buckets": []})
        return 0
    w = Buckets(db)
    w.append(keep)
    count = w.close()
    return count


def repair_missing(con, db, enc, status=None):
    """Re-embed rows a previous crashed run inserted but never sealed."""
    if not enc.ok:
        return 0
    rows = con.execute("SELECT id,text FROM turns WHERE vec_ok=0 ORDER BY id").fetchall()
    if not rows:
        return 0
    # A crash can land after the bucket write and before the vec_ok update, so
    # only embed rows that are genuinely absent from the stored buckets.
    present = set()
    man = load_manifest(db) or {}
    for entry in man.get("buckets", []):
        try:
            with np.load(bucket_dir(db) / entry["file"]) as z:
                present.update(int(i) for i in z["ids"])
        except Exception:
            pass
    already = [r for r in rows if int(r[0]) in present]
    if already:
        con.executemany("UPDATE turns SET vec_ok=1 WHERE id=?", [(int(r[0]),) for r in already])
        con.commit()
    rows = [r for r in rows if int(r[0]) not in present]
    if not rows:
        return 0
    w = Buckets(db)
    fixed = 0
    for i in range(0, len(rows), 256):
        chunk = rows[i:i + 256]
        vecs = enc.embed([r[1] for r in chunk])
        if vecs is None:
            break
        w.append([(int(r[0]), vecs[j]) for j, r in enumerate(chunk)])
        con.executemany("UPDATE turns SET vec_ok=1 WHERE id=?", [(int(r[0]),) for r in chunk])
        con.commit()
        fixed += len(chunk)
        write_status(status, {"phase": "repair", "done": fixed, "total": len(rows)})
    w.close()
    return fixed


def purge(db):
    """Drop every derived row and vector bucket, keeping the target files alone."""
    con = connect(db)
    init_db(con)
    con.execute("DELETE FROM turns")
    con.execute("DROP TABLE IF EXISTS turns_fts")
    con.execute("CREATE VIRTUAL TABLE turns_fts USING fts5(text)")
    con.execute("DELETE FROM meta")
    con.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('lex_version',?)", (LEX_VERSION,))
    con.commit()
    con.close()
    shutil.rmtree(bucket_dir(db), ignore_errors=True)
    dbp, vpath, ipath = db_paths(db)
    for legacy in (vpath, ipath):
        try:
            legacy.unlink()
        except Exception:
            pass
    return {"ok": True, "purged": str(dbp)}


def add_jsonl(db, jsonl, model_dir=None, status=None):
    t0 = time.time()
    con = connect(db)
    init_db(con)
    ensure_lex(con)
    enc = Encoder(model_dir)
    legacy = import_legacy(con, db)
    total = 0
    sessions_in_file = set()
    try:
        with open(jsonl, encoding="utf-8-sig") as fh:
            for line in fh:
                if not line.strip():
                    continue
                total += 1
                try:
                    sessions_in_file.add(str(json.loads(line).get("session_id", "")))
                except Exception:
                    pass
    except Exception:
        total = 0

    # Re-ingesting a session replaces its rows: redaction or extractor changes
    # must not leave the previous (possibly unredacted) copy behind.
    deleted = 0
    if sessions_in_file:
        marks = ",".join("?" for _ in sessions_in_file)
        ids = [r[0] for r in con.execute(
            f"SELECT id FROM turns WHERE session_id IN ({marks})",
            tuple(sessions_in_file)).fetchall()]
        if ids:
            deleted = len(ids)
            con.executemany("DELETE FROM turns_fts WHERE rowid=?", [(i,) for i in ids])
            con.execute(f"DELETE FROM turns WHERE session_id IN ({marks})",
                        tuple(sessions_in_file))
            con.commit()

    w = Buckets(db, dim=(enc.dim if enc.ok else 384))
    n_new, done, batch, redactions = 0, 0, [], 0
    write_status(status, {"phase": "embed", "done": 0, "total": total, "added": 0,
                          "model": enc.ok})

    def flush(batch):
        nonlocal n_new
        texts = [b[4] for b in batch]
        vecs = enc.embed(texts) if enc.ok else None
        rows = []
        for i, b in enumerate(batch):
            cur = con.execute(
                "INSERT OR IGNORE INTO turns(session_id,turn_idx,role,date,text,hash,vec,vec_ok)"
                " VALUES(?,?,?,?,?,?,NULL,0)",
                (b[0], b[1], b[2], b[3], b[4], b[5]),
            )
            if cur.rowcount:
                con.execute("INSERT INTO turns_fts(rowid,text) VALUES(?,?)",
                            (cur.lastrowid, " ".join(tokens(b[4]))))
                if vecs is not None:
                    rows.append((int(cur.lastrowid), vecs[i]))
                n_new += 1
        con.commit()
        if rows:
            w.append(rows)
            con.executemany("UPDATE turns SET vec_ok=1 WHERE id=?", [(r[0],) for r in rows])
            con.commit()

    with open(jsonl, encoding="utf-8-sig") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            text = str(r.get("text", "")).strip()
            if not text:
                continue
            text, redacted = redact(text)
            redactions += redacted
            seq = r.get("seq")
            key = f"{r.get('session_id')}|{seq}|{text}" if seq is not None \
                else f"{r.get('session_id')}|{r.get('turn_idx')}|{text}"
            h = hashlib.sha1(key.encode("utf-8")).hexdigest()
            batch.append((str(r.get("session_id", "")), int(r.get("turn_idx", 0) or 0),
                          r.get("role"), r.get("date"), text, h))
            done += 1
            if len(batch) >= 64:
                flush(batch)
                batch = []
                write_status(status, {"phase": "embed", "done": done, "total": total,
                                      "added": n_new, "model": enc.ok,
                                      "eta_sec": round((time.time() - t0) / max(done, 1)
                                                       * (total - done))})
        if batch:
            flush(batch)
            batch = []

    w.close()
    repaired = repair_missing(con, db, enc, status)
    if deleted:
        compact_buckets(con, db)
    try:
        (pathlib.Path(db).resolve().parent / "stats.json").unlink()
    except Exception:
        pass
    man = load_manifest(db) or {"count": 0, "buckets": []}
    con.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('model_ok',?)",
                ("1" if enc.ok else "0",))
    con.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('model_dir',?)", (str(enc.dir),))
    con.commit()
    con.close()
    con2 = connect(db)
    total_turns = con2.execute("SELECT COUNT(*) FROM turns").fetchone()[0]
    total_sessions = con2.execute("SELECT COUNT(DISTINCT session_id) FROM turns").fetchone()[0]
    con2.close()
    out = {"added": n_new, "vectors": man.get("count", 0), "model": enc.ok,
           "redacted": redactions,
           "buckets": len(man.get("buckets", [])), "legacy_imported": legacy,
           "repaired": repaired, "elapsed_sec": round(time.time() - t0, 1),
           "turns": total_turns, "sessions": total_sessions}
    write_status(status, {"phase": "ready", "done": total, "total": total, **out})
    return out


class Service:
    def __init__(self, db, model_dir=None):
        self.db = pathlib.Path(db).resolve()
        self.con = connect(self.db)
        init_db(self.con)
        ensure_lex(self.con)
        self.enc = Encoder(model_dir)
        self.rows = []
        self.ids = np.empty(0, dtype=np.int64)
        self.pos = {}
        self.texts = []
        self.buckets = []      # [(positions int64 array, matrix)]
        self.vec_count = 0
        self.pinned_pos = np.empty(0, dtype=np.int64)
        self.glossary = {}
        self._sig = None
        self.reload()
        self._repair_on_start()

    def _signature(self):
        try:
            return int(manifest_path(self.db).stat().st_mtime_ns)
        except Exception:
            return 0

    def reload(self):
        self.rows = self.con.execute(
            "SELECT id,session_id,turn_idx,role,date,text FROM turns ORDER BY id"
        ).fetchall()
        self.ids = np.array([r[0] for r in self.rows], dtype=np.int64)
        self.pos = {int(i): k for k, i in enumerate(self.ids)}
        self.texts = [r[5] for r in self.rows]
        self.pinned_pos = np.array(
            [k for k, r in enumerate(self.rows) if r[1] == PINNED_SESSION], dtype=np.int64)
        self.glossary = load_glossary(self.db.parent)
        self.buckets = []
        self.vec_count = 0
        self.dim = 0
        man = load_manifest(self.db)
        if man is not None:
            for b in man.get("buckets", []):
                try:
                    with np.load(bucket_dir(self.db) / b["file"], allow_pickle=False) as z:
                        ids = np.asarray(z["ids"], dtype=np.int64)
                        mat = np.asarray(z["mat"], dtype=np.float32)
                except Exception:
                    continue
                if len(ids) != len(mat):
                    continue
                keep = np.array([int(i) in self.pos for i in ids], dtype=bool)
                if not keep.all():
                    ids, mat = ids[keep], mat[keep]
                positions = np.array([self.pos[int(i)] for i in ids], dtype=np.int64)
                self.dim = int(mat.shape[1])
                self.buckets.append((positions, mat))
                self.vec_count += len(ids)
        else:
            # 0.1.x index: one flat matrix on disk.
            dbp, vpath, ipath = db_paths(self.db)
            if vpath.exists() and ipath.exists():
                try:
                    ids = np.load(ipath)
                    mat = np.load(vpath, mmap_mode="r")
                    if len(ids) == len(self.ids):
                        self.buckets = [(np.arange(len(ids), dtype=np.int64), mat)]
                        self.vec_count = len(ids)
                except Exception:
                    pass
        self._sig = self._signature()
        return {"turns": len(self.rows), "vectors": self.vec_count}

    def _repair_on_start(self, limit=200):
        """Re-embed rows a crashed `add` left without vectors.

        Capped so a large backlog never blocks the first query; the rest is
        picked up by the next ingest run.
        """
        try:
            pending = self.con.execute(
                "SELECT COUNT(*) FROM turns WHERE vec_ok=0").fetchone()[0]
        except Exception:
            return 0
        if not pending or not self.enc.ok or pending > limit:
            return 0
        fixed = repair_missing(self.con, self.db, self.enc)
        if fixed:
            self.reload()
        return fixed

    def _count(self):
        try:
            return self.con.execute("SELECT COUNT(*) FROM turns").fetchone()[0]
        except Exception:
            return len(self.rows)

    def _maybe_reload(self):
        if self._signature() != self._sig or self._count() != len(self.rows):
            self.reload()

    def _fts(self, query, limit=200):
        toks = tokens(query)
        if not toks:
            return {}
        seen, uniq = set(), []
        for t in toks:
            if t in seen:
                continue
            seen.add(t)
            uniq.append(t)
            if len(uniq) >= 96:
                break
        q = " OR ".join(f'"{t}"' for t in uniq)
        try:
            rows = self.con.execute(
                "SELECT rowid, bm25(turns_fts) AS s FROM turns_fts WHERE turns_fts MATCH ? "
                "ORDER BY rank LIMIT ?", (q, limit)
            ).fetchall()
        except sqlite3.OperationalError:
            return {}
        return {int(r[0]): -float(r[1]) for r in rows}

    def search(self, query, budget=3000):
        t0 = time.perf_counter()
        self._maybe_reload()
        if not self.rows:
            return {"query": query, "mode": "empty", "tokens": 0, "turns": [],
                    "n": 0, "latency_ms": round((time.perf_counter() - t0) * 1000, 2)}
        qv = self.enc.embed([query], kind="query")[0] if self.enc.ok else None
        sims = None
        # A model swapped without a rebuild has a different dimension: skip the
        # dense channel instead of raising, and let the caller see BM25 only.
        if qv is not None and self.buckets and len(qv) == self.buckets[0][1].shape[1]:
            sims = np.zeros(len(self.ids), dtype=np.float32)
            for positions, mat in self.buckets:
                sims[positions] = mat @ qv
        fts = self._fts(expand_query(query, self.glossary))

        if sims is None:
            if not fts:
                return {"query": query, "mode": "bm25", "tokens": 0, "turns": [],
                        "n": len(self.rows),
                        "latency_ms": round((time.perf_counter() - t0) * 1000, 2)}
            order = sorted(fts, key=lambda i: -fts[i])
            sel, used = [], 0
            for tid in order:
                k = self.pos.get(tid)
                if k is None:
                    continue
                t = est_tok(self.texts[k])
                if used + t > budget and sel:
                    continue
                sel.append(k)
                used += t
                if used >= budget:
                    break
            mode, scores = "bm25", {k: fts[self.ids[k]] for k in sel}
        else:
            def z(a):
                a = np.asarray(a, dtype=np.float32)
                return (a - a.mean()) / (a.std() + 1e-6)

            bvec = np.zeros(len(self.ids), dtype=np.float32)
            for tid, s in fts.items():
                k = self.pos.get(tid)
                if k is not None:
                    bvec[k] = s
            # 0.3 dense / 0.7 lexical: on a real personal corpus the lexical
            # channel carries most of the signal once CJK bigrams exist.
            hyb = 0.3 * z(sims) + 0.7 * z(bvec)
            if len(self.pinned_pos):
                hyb = hyb.copy()
                hyb[self.pinned_pos] += PINNED_BOOST
            order = np.argsort(-hyb)
            sel, used = [], 0
            for k in order:
                t = est_tok(self.texts[k])
                if used + t > budget and sel:
                    continue
                sel.append(int(k))
                used += t
                if used >= budget:
                    break
            mode, scores = "hybrid", {k: float(hyb[k]) for k in sel}

        out = []
        for k in sel:
            r = self.rows[k]
            out.append({"id": int(r[0]), "session_id": r[1], "turn_idx": r[2],
                        "role": r[3], "date": r[4], "text": r[5],
                        "score": round(float(scores.get(k, 0.0)), 4),
                        "tokens": est_tok(r[5])})
        return {"query": query, "mode": mode, "tokens": used, "turns": out,
                "n": len(self.rows), "latency_ms": round((time.perf_counter() - t0) * 1000, 2)}

    def stats(self):
        dbp, _, _ = db_paths(self.db)
        man = load_manifest(self.db) or {}
        bdir = bucket_dir(self.db)
        vmb = sum(p.stat().st_size for p in bdir.glob("*.npz")) / 1e6 if bdir.exists() else 0.0
        n = self.con.execute("SELECT COUNT(*) FROM turns").fetchone()[0]
        sess = self.con.execute("SELECT COUNT(DISTINCT session_id) FROM turns").fetchone()[0]
        vec = self.con.execute("SELECT COUNT(*) FROM turns WHERE vec_ok=1").fetchone()[0]
        return {"turns": n, "sessions": sess, "vectors": vec, "model_ok": self.enc.ok,
                "model": self.enc.spec.get("name"), "pooling": self.enc.pooling,
                "buckets": len(man.get("buckets", [])), "bucket_cap": man.get("cap"),
                "db_mb": round(dbp.stat().st_size / 1e6, 2) if dbp.exists() else 0,
                "vectors_mb": round(vmb, 2)}


def serve(db, model_dir=None):
    svc = Service(db, model_dir)
    # signal readiness; flush immediately so the host can start sending queries
    print(json.dumps({"ok": True, "ready": True, "turns": len(svc.rows),
                      "model_ok": svc.enc.ok}, ensure_ascii=False), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"bad json: {e}"}), flush=True)
            continue
        cmd = req.get("cmd")
        if cmd == "reload":
            info = svc.reload()
            print(json.dumps({"ok": True, "reloaded": info}), flush=True)
            continue
        if cmd == "stats":
            print(json.dumps({"ok": True, **svc.stats()}, ensure_ascii=False), flush=True)
            continue
        if cmd == "ping":
            print(json.dumps({"ok": True, "pong": True}), flush=True)
            continue
        if cmd == "shutdown":
            print(json.dumps({"ok": True, "bye": True}), flush=True)
            return
        try:
            out = svc.search(req.get("query", ""), int(req.get("budget", 3000)))
            out["ok"] = True
            print(json.dumps(out, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}), flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("init", "add", "search", "stats", "serve", "purge"):
        p = sub.add_parser(name)
        p.add_argument("--db", required=True)
        p.add_argument("--model-dir", default=None)
        if name == "add":
            p.add_argument("--jsonl", required=True)
            p.add_argument("--status", default=None)
        if name == "search":
            p.add_argument("--query", required=True)
            p.add_argument("--budget", type=int, default=3000)
        if name == "stats":
            p.add_argument("--out", default=None)
    args = ap.parse_args()
    if args.cmd == "init":
        con = connect(args.db)
        init_db(con)
        con.close()
        print(json.dumps({"ok": True, "db": str(pathlib.Path(args.db).resolve())}))
    elif args.cmd == "add":
        print(json.dumps(add_jsonl(args.db, args.jsonl, args.model_dir, args.status),
                         ensure_ascii=False))
    elif args.cmd == "search":
        svc = Service(args.db, args.model_dir)
        print(json.dumps(svc.search(args.query, args.budget), ensure_ascii=False))
    elif args.cmd == "stats":
        svc = Service(args.db, args.model_dir)
        info = svc.stats()
        info["at"] = int(time.time() * 1000)
        if getattr(args, "out", None):
            write_status(args.out, info)
        print(json.dumps(info, ensure_ascii=False))
    elif args.cmd == "purge":
        print(json.dumps(purge(args.db), ensure_ascii=False))
    else:
        serve(args.db, args.model_dir)


if __name__ == "__main__":
    main()
