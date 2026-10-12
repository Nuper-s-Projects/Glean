import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { applyServerModelPlan, getServer, getServerModelPlans, prepareServerModelPlan, startServerModelChat } from '../../app/dmApi';
import './ServerModelPanel.css';

const ServerModelMarkdown = lazy(() => import('./ServerModelMarkdown'));

const EXAMPLES = ['Build a welcoming gaming server with rules, announcements, text channels and voice channels.', 'Create a blue Helpers role with permission to manage messages, then add a support channel.', 'Set general slowmode to 10 seconds and write a welcome message.'];
const fieldLabels = { name: 'Name', channel: 'Channel', category: 'Category', categories: 'Category order', channels: 'Channel order', member: 'Member', role: 'Role', channelType: 'Channel type', permissions: 'Role permissions', permissionFlags: 'Permissions', color: 'Color', body: 'Message', messageId: 'Message ID', isPublic: 'Public server', moderationEnabled: 'Moderation', locked: 'Staff only posting', slowmode: 'Slowmode (seconds)', topic: 'Topic', description: 'Description', seconds: 'Timeout (seconds)', reason: 'Reason', installed: 'Nura installed', expiresInHours: 'Expiry (hours)', maxUses: 'Maximum uses' };

export default function ServerModelPanel({ server, onServerUpdated, controlsTarget }) {
  const [plans, setPlans] = useState([]);
  const [chatId, setChatId] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState('loading');
  const [error, setError] = useState('');
  const [allowAll, setAllowAll] = useState(false);
  const warningRef = useRef(null);
  const operationRef = useRef(false);
  useEffect(() => { setAllowAll(false); warningRef.current?.close(); }, [server.id]);
  const inputRef = useRef(null);
  const conversationRef = useRef(null);
  useEffect(() => {
    let active = true;
    setBusy('loading');
    getServerModelPlans(server.id).then((data) => { if (active) { setPlans(data.plans); setChatId(data.chatId); setError(''); } })
      .catch((reason) => { if (active) setError(reason.message); }).finally(() => { if (active) setBusy(''); });
    return () => { active = false; };
  }, [server.id]);
  useEffect(() => {
    if (busy !== 'loading' && conversationRef.current) conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
  }, [plans.length, busy]);
  useEffect(() => {
    const input = inputRef.current;
    if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; }
  }, [prompt]);
  useEffect(() => {
    const input = inputRef.current;
    let width = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, []);
  async function prepare(event) {
    event.preventDefault();
    if (busy || operationRef.current || !prompt.trim()) return;
    operationRef.current = true;
    setBusy('preparing'); setError('');
    try {
      const data = await prepareServerModelPlan(server.id, prompt.trim(), allowAll, chatId);
      setPlans((current) => [...current.map((plan) => data.plan.actions.length && plan.state === 'ready' ? { ...plan, state: 'superseded' } : plan), data.plan]); setPrompt('');
      if (allowAll && data.plan.state === 'ready' && data.plan.actions.length) {
        setBusy(data.plan.id);
        await executePlan(data.plan);
      }
    } catch (reason) { await handleFailure(reason); }
    finally { operationRef.current = false; setBusy(''); inputRef.current?.focus(); }
  }
  async function executePlan(plan) {
      setPlans((current) => current.map((item) => item.id === plan.id ? { ...item, state: 'applying' } : item));
      const data = await applyServerModelPlan(server.id, plan.id);
      setPlans((current) => current.map((item) => item.id === plan.id ? data.plan : item));
      const refreshed = await getServer(server.id);
      onServerUpdated?.(refreshed.server);
  }
  async function handleFailure(reason) {
      setError(reason.message);
      try { const data = await getServerModelPlans(server.id); setPlans(data.plans); setChatId(data.chatId); if (data.chatId !== chatId) setAllowAll(false); } catch {}
  }
  async function newChat() {
    if (busy || operationRef.current) return;
    operationRef.current = true; setBusy('new-chat'); setError('');
    try {
      const data = await startServerModelChat(server.id);
      setChatId(data.chatId); setPlans([]); setPrompt(''); setAllowAll(false); warningRef.current?.close();
    } catch (reason) { setError(reason.message); }
    finally { operationRef.current = false; setBusy(''); inputRef.current?.focus(); }
  }
  async function apply(plan) {
    if (busy || operationRef.current) return;
    operationRef.current = true;
    setBusy(plan.id); setError('');
    try { await executePlan(plan); }
    catch (reason) { await handleFailure(reason); }
    finally { operationRef.current = false; setBusy(''); }
  }
  return <section className={`server-model-panel${!plans.length ? ' is-empty' : ''}`} aria-label="ML model">
    {controlsTarget ? createPortal(<><button type="button" className="server-model-new-chat server-model-header-toggle" disabled={Boolean(busy)} aria-label="New chat" title="New chat" onClick={newChat}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg><span>{busy === 'new-chat' ? 'Starting…' : 'New chat'}</span></button><button type="button" className="server-model-allow-all server-model-header-toggle" aria-pressed={allowAll} disabled={Boolean(busy)} title="Automatically apply new changes" onClick={() => { if (allowAll) setAllowAll(false); else warningRef.current?.showModal(); }}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" /><path d="M12 8v5" /><circle cx="12" cy="16" r=".8" fill="currentColor" stroke="none" /></svg><span>Allow all{allowAll ? ' · On' : ''}</span></button></>, controlsTarget) : null}
    <div ref={conversationRef} className="server-model-scroll">
    <div className="server-model-conversation" aria-live="polite" aria-busy={Boolean(busy)}>
      {busy === 'loading' ? <div className="server-model-skeleton"><span /><span /><span /></div> : null}
      {!plans.length && !busy ? <div className="server-model-welcome"><h2>What would you like to build?</h2><p>Make {server.name} your own.</p><div className="server-model-starters">{EXAMPLES.map((example, index) => <button type="button" key={example} onClick={() => { setPrompt(example); inputRef.current?.focus(); }}><strong>{['Build my server', 'Set up roles', 'Manage a channel'][index]}</strong><span>{['Rules, channels and voice spaces', 'Permissions and member roles', 'Slowmode and a welcome message'][index]}</span></button>)}</div></div> : null}
      {plans.map((plan) => <article className="server-model-turn" key={plan.id}>
        <p className="server-model-user"><span className="sr-only">You: </span>{plan.request}</p>
        <div className="server-model-answer"><strong>ML model</strong><Suspense fallback={<p>{plan.summary}</p>}><ServerModelMarkdown>{plan.summary}</ServerModelMarkdown></Suspense>
          {plan.actions.length ? <div className="server-model-proposal"><details open={plan.state === 'ready' || plan.state === 'failed'}><summary className="server-model-proposal-heading"><strong>{plan.actions.length} proposed {plan.actions.length === 1 ? 'change' : 'changes'}</strong><span>{plan.state === 'done' ? 'Applied' : plan.state === 'failed' ? 'Stopped' : plan.state === 'superseded' ? 'Replaced' : plan.state === 'interrupted' ? 'Interrupted' : plan.state === 'applying' ? 'Applying' : 'Review changes'}</span></summary>
            <ol>{plan.actions.map((action, index) => {
              const result = plan.results.find((item) => item.index === index);
              return <li key={index}><div className="server-model-action-title"><strong>{action.label}</strong>{result ? <span className={result.ok ? 'server-model-success' : 'server-model-failure'}>{result.ok ? 'Done' : 'Failed'}</span> : null}</div>
                <dl>{Object.entries(action).filter(([key]) => key !== 'type' && key !== 'label').map(([key, value]) => <div key={key}><dt>{fieldLabels[key] || key}</dt><dd>{Array.isArray(value) ? value.join(', ') || 'None' : typeof value === 'boolean' ? value ? 'On' : 'Off' : String(value)}</dd></div>)}</dl>
                {result?.error ? <p className="server-model-failure">{result.error}</p> : null}
                {result?.invite ? <p>Invite code: <code>{result.invite.code}</code></p> : null}
              </li>;
            })}</ol></details>
            {plan.state === 'ready' ? <button type="button" className="community-dialog-primary" disabled={Boolean(busy)} onClick={() => apply(plan)}>{busy === plan.id ? 'Applying changes…' : 'Apply changes'}</button> : null}
            {plan.state === 'failed' || plan.state === 'interrupted' ? <p className="server-model-caption">Completed changes were kept. Describe the remaining changes to prepare a new proposal.</p> : null}
          </div> : null}
        </div>
      </article>)}
      {busy === 'preparing' ? <p className="server-model-thinking" role="status">Preparing your changes…</p> : null}
    </div>
    </div>
    <div className="server-model-dock">
      {error ? <p className="server-model-error" role="alert">{error}</p> : null}
      <form className="server-model-composer" onSubmit={prepare}><label htmlFor={`server-model-prompt-${server.id}`} className="sr-only">What would you like to change?</label><textarea id={`server-model-prompt-${server.id}`} ref={inputRef} value={prompt} maxLength={4000} rows={1} placeholder="Describe your server or the changes you want…" disabled={Boolean(busy)} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) prepare(event); }} /><div><span className="server-model-caption">{prompt.length ? `${prompt.length}/4,000` : 'Shift + Enter for a new line'}</span><button type="submit" className="server-model-send" aria-label="Prepare changes" title="Prepare changes" disabled={Boolean(busy) || !prompt.trim()}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg></button></div></form>
      <p className="server-model-caption server-model-disclaimer">{allowAll ? 'Allow all is on. New changes are applied automatically.' : 'Review changes before applying.'} Your server permissions always apply.</p>
    </div>
    <dialog ref={warningRef} className="server-model-warning" aria-labelledby="server-model-warning-title" aria-describedby="server-model-warning-description" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); warningRef.current.close(); } }} onClick={(event) => { if (event.target === warningRef.current) warningRef.current.close(); }}>
      <div><h2 id="server-model-warning-title">Allow automatic changes?</h2><p id="server-model-warning-description">The AI will automatically propose and apply supported changes for your new requests without asking you to click Apply changes. This includes roles, permissions, channels, server settings, messages and moderation actions, including deletions, kicks and bans.</p><p>Changes can affect members and may be destructive. Existing proposals are not applied by enabling this. Your server permissions still apply. Turn Allow all off to return to manual review. It resets when you leave this page.</p><div className="server-model-warning-actions"><button type="button" autoFocus onClick={() => warningRef.current.close()}>Cancel</button><button type="button" className="server-model-allow-all" onClick={() => { setAllowAll(true); warningRef.current.close(); }}>Enable Allow all</button></div></div>
    </dialog>
  </section>;
}
