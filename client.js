/**
 * Throughline memory — Settings section (web client).
 *
 * A read-mostly management page for the local memory index: live counts, which
 * workspaces are indexed, and three real actions (pause/resume, reindex,
 * clear). Data comes from the Host plugin's own routes under
 * `/throughline/*`; nothing is mocked.
 */
window.__ModuleLoader__.load({
  id: '@local/throughline',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ZH = /^zh/i.test((typeof navigator !== 'undefined' && navigator.language) || '') ||
      /^zh/i.test((typeof document !== 'undefined' && document.documentElement.lang) || '');
    const T = ZH
      ? {
        title: '记忆',
        heading: '本地记忆',
        intro: '索引是会话日志的派生缓存，源永远是可读的会话文件。这里只做范围与重建，不编辑内容。',
        loading: '正在读取索引状态…',
        unreachable: '无法连接 Host。更新插件后需要重启 DSH 才会加载管理路由。',
        turns: '对话轮次',
        sessions: '已索引会话',
        size: '占用空间',
        buckets: '向量分桶',
        status: '状态',
        paused: '已暂停',
        running: '运行中',
        model: '语义模型',
        modelOk: '可用',
        modelOff: '缺失（仅词法）',
        lastIngest: '上次入库',
        never: '还没有入库记录',
        sources: '已入库的来源',
        sourceWorkspace: '工作区',
        sourceSessions: '会话',
        sourceLast: '最近',
        actions: '操作',
        notifyLabel: '触发时显示提示',
        notifyHint: '检索或后台入库时，在右下角短暂弹出提示',
        on: '开',
        off: '关',
        toastSearch: '记忆调用',
        toastIngest: '记忆入库',
        toastTurns: '对话落盘',
        toastIngestDone: '记忆入库完成',
        toastError: '记忆出错',
        toastStartFull: '开始全量建库',
        toastStartInc: '开始增量入库',
        stale: '索引刚更新，数字可能滞后',
        excludeTitle: '范围与排除',
        excludeHint: '排除的工作区/会话/关键词不会被新入库；已入库的内容在“重建索引”后消失。',
        excludeWs: '工作区',
        excludeSession: '会话',
        excludeKeyword: '关键词',
        removeSource: '移除',
        sourceExcluded: '已排除',
        excludeEmpty: '还没有排除规则',
        excludeRemove: '移除',
        restartPending: '插件已更新，重启 DSH 后生效',
        service: '服务',
        restarts: '重启',
        history: '最近入库',
        usageTitle: '使用统计',
        usageCalls: '调用',
        usageToday: '今日',
        usageHit: '命中率',
        usageTrigger: '触发率',
        usageEmpty: '空结果率',
        usageTokens: '注入 token',
        usageAvg: '平均/次',
        usageAvoided: '估算节省',
        usageSaved: '折算时间',
        usageShare: '占原文比例',
        usageLatency: '延迟 p50/p95',
        usageCost: '花销',
        usageCostOff: '未配置单价（control.json → pricePerMTok）',
        usageNote: '节省为估算：用命中轮次所在会话的 token 体积减去实际注入量；时间按 300 tok/s 重读折算。',
        humanLayer: '手工记忆',
        pinnedCount: '条规则',
        glossaryCount: '条术语',
        backoff: '入库已退避，约',
        pause: '暂停自动入库',
        resume: '恢复自动入库',
        reindex: '重建索引',
        clear: '清空索引',
        confirmReindex: '确认重建？会先清空再全量入库',
        confirmClear: '确认清空？只删派生索引，不动会话日志',
        yes: '确认',
        cancel: '取消',
        working: '处理中…',
        note: '清空与重建只影响本机派生索引；会话日志不会被修改。排除某些项目入库尚未在这个样例里实现。',
        noSources: '索引里还没有任何会话。',
      }
      : {
        title: 'Memory',
        heading: 'Local memory',
        intro: 'The index is a derived cache over session logs; the logs stay the source of truth. Manage scope and rebuild here — content is not editable.',
        loading: 'Reading index status…',
        unreachable: 'Cannot reach the Host. Restart DSH after updating the plugin to load the management routes.',
        turns: 'Dialogue turns',
        sessions: 'Sessions indexed',
        size: 'Disk used',
        buckets: 'Vector buckets',
        status: 'Status',
        paused: 'Paused',
        running: 'Running',
        model: 'Embedding model',
        modelOk: 'available',
        modelOff: 'missing (lexical only)',
        lastIngest: 'Last ingest',
        never: 'No ingest recorded yet',
        sources: 'Indexed sources',
        sourceWorkspace: 'Workspace',
        sourceSessions: 'Sessions',
        sourceLast: 'Last',
        actions: 'Actions',
        notifyLabel: 'Show a popup when triggered',
        notifyHint: 'A brief toast in the bottom-right corner on each search or background ingest',
        on: 'On',
        off: 'Off',
        toastSearch: 'Memory search',
        toastIngest: 'Memory ingest',
        toastTurns: 'Turns indexed',
        toastIngestDone: 'Memory ingest finished',
        toastError: 'Memory error',
        toastStartFull: 'Full rebuild started',
        toastStartInc: 'Incremental ingest started',
        stale: 'index just changed; counts may lag',
        excludeTitle: 'Scope and exclusions',
        excludeHint: 'Excluded workspaces, sessions and keywords are skipped by future ingests; already-indexed content disappears after “Rebuild index”.',
        excludeWs: 'Workspace',
        excludeSession: 'Session',
        excludeKeyword: 'Keyword',
        removeSource: 'Remove',
        sourceExcluded: 'Excluded',
        excludeEmpty: 'No exclusion rules yet',
        excludeRemove: 'Remove',
        restartPending: 'plugin updated; restart DSH to apply',
        service: 'Service',
        restarts: 'restarts',
        history: 'Recent ingests',
        usageTitle: 'Usage',
        usageCalls: 'calls',
        usageToday: 'today',
        usageHit: 'hit rate',
        usageTrigger: 'trigger rate',
        usageEmpty: 'empty rate',
        usageTokens: 'injected tokens',
        usageAvg: 'avg/call',
        usageAvoided: 'est. saved',
        usageSaved: 'time saved',
        usageShare: 'share of source',
        usageLatency: 'latency p50/p95',
        usageCost: 'cost',
        usageCostOff: 'no unit price (control.json → pricePerMTok)',
        usageNote: 'Savings are estimates: tokens of the sessions behind the hits minus what was injected; time assumes re-reading at 300 tok/s.',
        humanLayer: 'Hand-written memory',
        pinnedCount: 'rules',
        glossaryCount: 'terms',
        backoff: 'ingest paused after failures, resumes in',
        pause: 'Pause auto-indexing',
        resume: 'Resume auto-indexing',
        reindex: 'Rebuild index',
        clear: 'Clear index',
        confirmReindex: 'Rebuild? Clears the index, then re-ingests everything',
        confirmClear: 'Clear? Removes the derived index only, never session logs',
        yes: 'Confirm',
        cancel: 'Cancel',
        working: 'Working…',
        note: 'Clear and rebuild only touch the local derived index; session logs are never modified. Excluding specific projects is not part of this sample yet.',
        noSources: 'No sessions indexed yet.',
      };

    const S = {
      page: {
        padding: '22px 26px 30px', maxWidth: 780, color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit', lineHeight: 1.55,
      },
      h2: { margin: '0 0 6px', fontSize: 18, fontWeight: 600 },
      intro: { margin: '0 0 18px', fontSize: 13, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,1))' },
      cards: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, marginBottom: 18 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))',
        background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.06))',
        borderRadius: 10, padding: '12px 14px',
      },
      cardLabel: { fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,1))' },
      cardValue: { fontSize: 22, fontWeight: 600, marginTop: 4, fontVariantNumeric: 'tabular-nums' },
      cardSub: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,1))', marginTop: 2 },
      banner: {
        border: '1px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.35))',
        background: 'rgba(214, 158, 46, 0.12)', borderRadius: 8, padding: '9px 12px',
        fontSize: 12.5, marginBottom: 16,
      },
      danger: {
        border: '1px solid var(--dsw-alias-state-error-primary, #c0392b)',
        background: 'rgba(192, 57, 43, 0.10)', borderRadius: 8, padding: '9px 12px',
        fontSize: 12.5, marginBottom: 16,
      },
      row: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5, padding: '5px 0' },
      key: { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,1))' },
      hr: { border: 0, borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))', margin: '16px 0' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 },
      th: { textAlign: 'left', fontWeight: 500, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,1))', padding: '4px 8px 6px 0', fontSize: 11 },
      td: { padding: '4px 8px 4px 0', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.15))' },
      ws: {
        maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11.5,
      },
      actions: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 },
      btn: {
        font: 'inherit', fontSize: 12.5, padding: '6px 12px', borderRadius: 7, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.4))',
        background: 'transparent', color: 'inherit',
      },
      primary: {
        font: 'inherit', fontSize: 12.5, padding: '6px 12px', borderRadius: 7, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-state-business-primary, #247bbf)',
        background: 'var(--dsw-alias-state-business-primary, #247bbf)', color: '#fff',
      },
      ghost: { font: 'inherit', fontSize: 12.5, padding: '6px 12px', borderRadius: 7, cursor: 'pointer', border: '1px solid transparent', background: 'transparent', color: 'inherit', opacity: 0.75 },
      note: { marginTop: 18, fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,1))' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      switchRow: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        padding: '10px 0 2px',
      },
      switchText: { display: 'flex', flexDirection: 'column', gap: 2 },
      switchLabel: { fontSize: 13 },
      switchHint: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,1))' },
      toggle: {
        font: 'inherit', fontSize: 12, minWidth: 54, padding: '4px 10px', borderRadius: 999,
        cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.4))',
        background: 'transparent', color: 'inherit',
      },
      toggleOn: {
        font: 'inherit', fontSize: 12, minWidth: 54, padding: '4px 10px', borderRadius: 999,
        cursor: 'pointer', border: '1px solid var(--dsw-alias-state-business-primary, #247bbf)',
        background: 'var(--dsw-alias-state-business-primary, #247bbf)', color: '#fff',
      },
      toastLayer: {
        position: 'fixed', right: 18, bottom: 18, zIndex: 9999,
        display: 'flex', flexDirection: 'column-reverse', gap: 8,
        pointerEvents: 'none',
      },
      toast: {
        minWidth: 210, maxWidth: 340, padding: '10px 12px', borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-3, rgba(28,28,30,0.94))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
        transition: 'opacity 0.35s ease, transform 0.35s ease',
        wordBreak: 'break-word',
      },
      toastTitle: { fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 },
      toastBody: { fontSize: 11.5, marginTop: 3, opacity: 0.82, lineHeight: 1.45 },
      toastDot: { width: 7, height: 7, borderRadius: '50%', background: 'var(--dsw-alias-state-business-primary, #247bbf)' },
    };

    function fmtInt(n) {
      const v = Number(n);
      return Number.isFinite(v) ? v.toLocaleString() : '—';
    }
    function fmtMb(n) {
      const v = Number(n) || 0;
      return v >= 1000 ? `${(v / 1000).toFixed(1)} GB` : `${v.toFixed(1)} MB`;
    }
    function fmtTime(ms) {
      if (!ms) return '—';
      const d = new Date(Number(ms));
      if (Number.isNaN(d.getTime())) return '—';
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    async function call(pathname, init) {
      const res = await fetch(pathname, Object.assign({ cache: 'no-store' }, init || {}));
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
      return body;
    }

    function MemoryPanel() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [confirming, setConfirming] = React.useState(null);

      const load = React.useCallback(async () => {
        try {
          setState(await call('/throughline/status'));
          setError(null);
        } catch (e) {
          setError(String(e.message || e));
        }
      }, []);

      React.useEffect(() => {
        load();
        const id = setInterval(load, 5000);
        return () => clearInterval(id);
      }, [load]);

      const run = React.useCallback(async (name, extra) => {
        setBusy(name);
        setConfirming(null);
        try {
          const out = await call('/throughline/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: name, ...(extra || {}) }),
          });
          if (out.status) setState(out.status);
          else await load();
          setError(null);
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy(null);
        }
      }, [load]);

      const s = state;
      const cards = s ? [
        { label: T.turns, value: fmtInt(s.index.turns), sub: `${T.buckets}: ${s.index.buckets}${s.index.cap ? ` × ${fmtInt(s.index.cap)}` : ''}` },
        { label: T.sessions, value: fmtInt(s.index.sessions), sub: T.sourceWorkspace + `: ${s.sourceCount}` },
        { label: T.size, value: fmtMb(s.index.dbMb + s.index.vectorsMb), sub: `DB ${fmtMb(s.index.dbMb)} · vec ${fmtMb(s.index.vectorsMb)}` },
      ] : [];

      return h('section', { style: S.page, 'aria-busy': busy ? 'true' : 'false' },
        h('h2', { style: S.h2 }, T.heading),
        h('p', { style: S.intro }, T.intro),

        error ? h('div', { style: S.danger, role: 'alert' }, T.unreachable, h('div', { style: { ...S.mono, marginTop: 6, opacity: 0.7, fontSize: 11 } }, error)) : null,
        s && s.restartPending
          ? h('div', { style: S.banner }, `${T.restartPending} · v${s.version} · loaded ${s.loadedVersion}`)
          : null,
        s && s.paused ? h('div', { style: S.banner }, T.paused, s.model ? '' : ` · ${T.model}: ${T.modelOff}`) : null,

        !s && !error ? h('div', { style: S.key, role: 'status' }, T.loading) : null,

        s ? h('div', { style: S.cards },
          cards.map((c) => h('div', { key: c.label, style: S.card },
            h('div', { style: S.cardLabel }, c.label),
            h('div', { style: S.cardValue }, c.value),
            h('div', { style: S.cardSub }, c.sub),
          )),
        ) : null,

        s ? h('div', null,
          h('div', { style: S.row },
            h('span', { style: S.key }, T.status),
            h('span', null, s.paused ? T.paused : T.running, ' · ', T.model, ': ', s.model ? T.modelOk : T.modelOff),
          ),
          s.stale ? h('div', { style: { ...S.row, color: 'var(--dsw-alias-label-tertiary, inherit)' } },
            h('span', { style: S.key }, ''),
            h('span', null, T.stale),
          ) : null,
          s.backoffUntil && s.backoffUntil > Date.now()
            ? h('div', { style: { ...S.row, color: 'var(--dsw-alias-label-tertiary, inherit)' } },
              h('span', { style: S.key }, ''),
              h('span', null, `${T.backoff} ${Math.ceil((s.backoffUntil - Date.now()) / 60000)} min (${s.failures})`),
            ) : null,
          h('div', { style: S.row },
            h('span', { style: S.key }, T.lastIngest),
            h('span', null, s.lastIngest
              ? `${fmtTime(s.lastIngest.at)} · ${s.lastIngest.phase}${s.lastIngest.added != null ? ` · +${fmtInt(s.lastIngest.added)}` : ''}${s.lastIngest.error ? ' · error' : ''}`
              : T.never),
          ),
          s.lastIngest && s.lastIngest.error
            ? h('div', { style: { ...S.mono, fontSize: 11, opacity: 0.75, marginTop: 4, whiteSpace: 'pre-wrap' } }, String(s.lastIngest.error).slice(-600))
            : null,
          s.service
            ? h('div', { style: S.row },
              h('span', { style: S.key }, T.service),
              h('span', null, `${s.service.state}${s.service.restarts ? ` · ${T.restarts} ${s.service.restarts}` : ''}${s.service.lastError ? ` · ${String(s.service.lastError).slice(0, 60)}` : ''}`),
            )
            : null,
          s.human
            ? h('div', { style: S.row },
              h('span', { style: S.key }, T.humanLayer),
              h('span', { title: `${s.human.pinnedFile}\n${s.human.glossaryFile}` },
                `${s.human.pinned} ${T.pinnedCount} · ${s.human.glossary} ${T.glossaryCount}`),
            )
            : null,
          s.history && s.history.length
            ? h('div', { style: { marginTop: 6 } },
              h('div', { style: { ...S.cardLabel, marginBottom: 4 } }, T.history),
              s.history.slice(0, 4).map((h0, i) => h('div', { key: i, style: { ...S.switchHint, ...S.mono, fontSize: 11 } },
                `${fmtTime(h0.at)} · ${h0.phase || '-'} · +${fmtInt(h0.added)} · ${fmtInt(h0.turns)} turns`
                + `${h0.redacted ? ` · redacted ${h0.redacted}` : ''}${h0.filtered ? ` · filtered ${h0.filtered}` : ''}`)),
            )
            : null,
        ) : null,

        s && s.usage ? h('hr', { style: S.hr }) : null,
        s && s.usage ? h('div', { style: { ...S.cardLabel, marginBottom: 6 } }, T.usageTitle) : null,
        s && s.usage ? h('div', { style: S.cards },
          h('div', { style: S.card },
            h('div', { style: S.cardLabel }, T.usageCalls),
            h('div', { style: S.cardValue }, fmtInt(s.usage.calls)),
            h('div', { style: S.cardSub }, `${T.usageToday}: ${fmtInt(s.usage.callsToday)} · ${T.usageHit}: ${(s.usage.hitRate * 100).toFixed(0)}%`),
          ),
          h('div', { style: S.card },
            h('div', { style: S.cardLabel }, T.usageTokens),
            h('div', { style: S.cardValue }, fmtInt(s.usage.injectedTokens)),
            h('div', { style: S.cardSub }, `${T.usageAvg}: ${fmtInt(s.usage.avgTokensPerCall)} · ${fmtInt(s.usage.turnsReturned)} turns`),
          ),
          h('div', { style: S.card },
            h('div', { style: S.cardLabel }, T.usageAvoided),
            h('div', { style: S.cardValue }, fmtInt(s.usage.avoidedTokens)),
            h('div', { style: S.cardSub }, `${T.usageSaved}: ${fmtInt(s.usage.savedSeconds)}s · ${T.usageShare}: ${(s.usage.share * 100).toFixed(1)}%`),
          ),
        ) : null,
        s && s.usage ? h('div', { style: S.row },
          h('span', { style: S.key }, T.usageLatency),
          h('span', null, `${fmtInt(s.usage.latencyP50)} / ${fmtInt(s.usage.latencyP95)} ms · ${T.usageCost}: ${s.usage.cost != null ? s.usage.cost : T.usageCostOff}`),
        ) : null,
        s && s.usage ? h('div', { style: S.row },
          h('span', { style: S.key }, T.usageTrigger),
          h('span', null, `${((s.usage.triggerRate || 0) * 100).toFixed(0)}% (${fmtInt(s.usage.sessionsWithCall)}/${fmtInt(s.usage.sessionsStarted)}) · ${s.usage.callsPerSession || 0} /会话 · ${T.usageEmpty}: ${((s.usage.emptyRate || 0) * 100).toFixed(0)}%`),
        ) : null,
        s && s.usage ? h('div', { style: S.switchHint, marginBottom: 4 }, T.usageNote) : null,

        s ? h('hr', { style: S.hr }) : null,
        s ? h('div', { style: { ...S.cardLabel, marginBottom: 6 } }, T.sources) : null,
        s ? (s.sources.length
          ? h('table', { style: S.table },
            h('thead', null, h('tr', null,
              h('th', { style: S.th }, T.sourceWorkspace),
              h('th', { style: { ...S.th, width: 70 } }, T.sourceSessions),
              h('th', { style: { ...S.th, width: 130 } }, T.sourceLast),
              h('th', { style: { ...S.th, width: 64 } }, ''),
            )),
            h('tbody', null, s.sources.map((src) => {
              const excluded = ((s.exclude && s.exclude.workspaces) || []).includes(src.workspace);
              return h('tr', { key: src.workspace },
                h('td', { style: { ...S.td, ...S.ws }, title: src.workspace }, src.label),
                h('td', { style: S.td }, fmtInt(src.sessions)),
                h('td', { style: { ...S.td, ...S.key } }, fmtTime(src.last)),
                h('td', { style: S.td },
                  excluded
                    ? h('span', { style: { ...S.switchHint, fontSize: 11 } }, T.sourceExcluded)
                    : h('button', {
                      type: 'button',
                      style: { ...S.ghost, padding: '1px 6px', fontSize: 11 },
                      disabled: !!busy,
                      title: T.excludeHint,
                      onClick: () => run('exclude-add', { kind: 'workspaces', value: src.workspace }),
                    }, T.removeSource),
                ),
              );
            })),
          )
          : h('div', { style: S.key }, T.noSources)) : null,

        s ? h('hr', { style: S.hr }) : null,
        s ? h('div', { style: S.switchRow },
          h('div', { style: S.switchText },
            h('span', { style: S.switchLabel }, T.notifyLabel),
            h('span', { style: S.switchHint }, T.notifyHint),
          ),
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': s.notify ? 'true' : 'false',
            style: s.notify ? S.toggleOn : S.toggle,
            disabled: !!busy,
            onClick: () => run(s.notify ? 'notify-off' : 'notify-on'),
          }, s.notify ? T.on : T.off),
        ) : null,
        s ? h('div', { style: { ...S.hr } }) : null,
        s ? h('div', { style: { ...S.cardLabel, marginBottom: 8 } }, T.actions) : null,
        s ? h('div', { style: S.actions },
          h('button', {
            type: 'button', style: S.btn, disabled: !!busy,
            onClick: () => run(s.paused ? 'resume' : 'pause'),
          }, busy === (s.paused ? 'resume' : 'pause') ? T.working : (s.paused ? T.resume : T.pause)),

          confirming === 'reindex'
            ? h('span', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('span', { style: { fontSize: 12.5 } }, T.confirmReindex),
              h('button', { type: 'button', style: S.primary, onClick: () => run('reindex') }, T.yes),
              h('button', { type: 'button', style: S.ghost, onClick: () => setConfirming(null) }, T.cancel),
            )
            : h('button', { type: 'button', style: S.btn, disabled: !!busy, onClick: () => setConfirming('reindex') },
              busy === 'reindex' ? T.working : T.reindex),

          confirming === 'clear'
            ? h('span', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('span', { style: { fontSize: 12.5 } }, T.confirmClear),
              h('button', { type: 'button', style: S.primary, onClick: () => run('clear') }, T.yes),
              h('button', { type: 'button', style: S.ghost, onClick: () => setConfirming(null) }, T.cancel),
            )
            : h('button', { type: 'button', style: S.btn, disabled: !!busy, onClick: () => setConfirming('clear') },
              busy === 'clear' ? T.working : T.clear),
        ) : null,

        s ? h('hr', { style: S.hr }) : null,
        s ? h('div', { style: { ...S.cardLabel, marginBottom: 4 } }, T.excludeTitle) : null,
        s ? h('div', { style: S.switchHint, marginBottom: 8 }, T.excludeHint) : null,
        s ? h('div', null,
          ['workspaces', 'sessions', 'keywords'].map((kind) => {
            const label = kind === 'workspaces' ? T.excludeWs : kind === 'sessions' ? T.excludeSession : T.excludeKeyword;
            const list = (s.exclude && s.exclude[kind]) || [];
            if (!list.length && kind === 'keywords') return null;
            return h('div', { key: kind, style: { marginBottom: 6 } },
              h('div', { style: { ...S.switchHint, marginBottom: 4 } }, label),
              list.length
                ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                  list.map((value) => h('span', {
                    key: kind + value,
                    style: {
                      display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5,
                      padding: '3px 8px', borderRadius: 6,
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
                    },
                  },
                    h('span', { style: { ...S.mono, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: value }, value),
                    h('button', {
                      type: 'button', style: { ...S.ghost, padding: '0 4px', fontSize: 11 },
                      title: T.excludeRemove, disabled: !!busy,
                      onClick: () => run('exclude-remove', { kind, value }),
                    }, '×'),
                  )))
                : h('div', { style: S.switchHint }, T.excludeEmpty),
            );
          }),
        ) : null,
        h('p', { style: S.note }, T.note),
      );
    }

    function MemoryIcon(props) {
      const size = Number(props && props.size) || 18;
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('ellipse', { cx: 12, cy: 6, rx: 7, ry: 3 }),
        h('path', { d: 'M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6' }),
        h('path', { d: 'M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6' }),
      );
    }


    /** Copy for one trigger event, kept short enough for a corner toast. */
    function toastText(e) {
      const turnsWord = ZH ? '轮' : 'turns';
      if (e.kind === 'search') {
        const q = String(e.query || '').replace(/\s+/g, ' ').trim();
        const short = q.length > 42 ? `${q.slice(0, 42)}…` : q;
        return {
          title: T.toastSearch,
          body: `“${short}” · ${fmtInt(e.turns)} ${turnsWord} · ${fmtInt(e.tokens)} tok · ${fmtInt(e.ms)} ms`,
        };
      }
      if (e.kind === 'turns') {
        const n = Number(e.turns || 0);
        const sid = e.session ? String(e.session).replace(/^session-/, '').slice(0, 8) : '';
        const body = e.session ? `+${fmtInt(n)} ${turnsWord} · ${sid}` : `${fmtInt(e.sessions)} 个会话 · +${fmtInt(n)} ${turnsWord}`;
        return { title: T.toastTurns, body };
      }
      if (e.kind === 'ingest-start') {
        return { title: T.toastIngest, body: e.full ? T.toastStartFull : T.toastStartInc };
      }
      if (e.kind === 'ingest-done') {
        const parts = [];
        if (e.added != null) parts.push(`+${fmtInt(e.added)} ${turnsWord}`);
        if (e.elapsedMs != null) parts.push(`${(Number(e.elapsedMs) / 1000).toFixed(1)} s`);
        if (!parts.length && e.turns != null) parts.push(`${fmtInt(e.turns)} ${turnsWord}`);
        return { title: T.toastIngestDone, body: parts.join(' · ') || '—' };
      }
      return { title: T.toastError, body: String(e.message || '').slice(0, 140) };
    }

    /**
     * Corner toast layer. Polls the same status route as the settings page,
     * baselines on the newest event id so a fresh page never replays history,
     * and drops each toast after a short fade.
     */
    function ToastLayer() {
      const [toasts, setToasts] = React.useState([]);
      const lastId = React.useRef(null);

      React.useEffect(() => {
        let alive = true;
        let timers = [];

        const schedule = (items) => {
          for (const item of items) {
            timers.push(setTimeout(() => {
              setToasts((prev) => prev.map((x) => (x.key === item.key ? { ...x, leaving: true } : x)));
            }, 2300));
            timers.push(setTimeout(() => {
              setToasts((prev) => prev.filter((x) => x.key !== item.key));
            }, 2750));
          }
        };

        const tick = async () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          let st;
          try {
            st = await call('/throughline/status');
          } catch {
            return;
          }
          if (!alive) return;
          const events = Array.isArray(st.events) ? st.events : [];
          if (lastId.current === null) {
            lastId.current = events.length ? events[0].id : 0;
            return;
          }
          if (!st.notify) {
            if (events.length) lastId.current = events[0].id;
            return;
          }
          const fresh = events.filter((e) => e.id > lastId.current).sort((a, b) => a.id - b.id);
          if (!fresh.length) return;
          lastId.current = fresh[fresh.length - 1].id;
          const stamp = Date.now();
          const items = fresh.map((e) => ({ ...e, key: `${stamp}-${e.id}`, leaving: false }));
          setToasts((prev) => [...prev, ...items]);
          schedule(items);
        };

        tick();
        const timer = setInterval(tick, 2500);
        return () => {
          alive = false;
          clearInterval(timer);
          for (const t of timers) clearTimeout(t);
          timers = [];
        };
      }, []);

      if (!toasts.length) return null;
      return h('div', { style: S.toastLayer, 'aria-live': 'polite' },
        toasts.map((t) => {
          const copy = toastText(t);
          return h('div', {
            key: t.key,
            style: {
              ...S.toast,
              opacity: t.leaving ? 0 : 1,
              transform: t.leaving ? 'translateY(6px)' : 'none',
            },
          },
            h('div', { style: S.toastTitle }, h('span', { style: S.toastDot }), copy.title),
            h('div', { style: S.toastBody }, copy.body),
          );
        }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'throughline',
          order: 60,
          label: T.title,
        }, MemoryPanel));

        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'throughline',
          order: 60,
          label: T.title,
        }, MemoryIcon));

        // Frame-wide toast seat: bottom-right, click-through, one entry beside
        // whatever else the shipped composition puts in the overlay.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'throughline-toast',
          order: 40,
        }, ToastLayer));
      },
    };
  },
});
