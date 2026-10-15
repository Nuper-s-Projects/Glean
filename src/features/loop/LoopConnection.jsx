import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../app/apiClient';
import { ROUTES } from '../../app/routes';
import LoopAuraController from './LoopAuraController';

export default function LoopConnection({ account, goTo, onSignedOut, onAccountUpdated, children }) {
  const [state,setState] = useState({loading:true,connected:false,account:null,error:''});
  const [confirmed,setConfirmed] = useState(false);
  const [busy,setBusy] = useState(false);
  const [retry,setRetry] = useState(0);
  const lock = useRef(false);
  const alive = useRef(true);
  const connectionPath = new URLSearchParams(window.location.search).has('post') ? '/loop/connection' : '/loop/connection?includePosts=1';
  const signIn = () => {
    onSignedOut?.();
    window.location.replace('/signin?next=%2Floop');
  };
  useEffect(()=>{
    alive.current=true;
    const controller=new AbortController();
    setState({loading:true,connected:false,account:null,error:''});setConfirmed(false);
    if(!account?.id){signIn();return ()=>{alive.current=false;};}
    apiRequest(connectionPath,{signal:controller.signal}).then(data=>{
      if(controller.signal.aborted)return;
      if(data.account?.id!==account.id){signIn();return;}
      setState({loading:false,...data,error:''});
    }).catch(failure=>{
      if(controller.signal.aborted)return;
      if(failure.status===401){signIn();return;}
      setState({loading:false,connected:false,account:null,error:failure.message});
    });
    return ()=>{alive.current=false;controller.abort();};
  },[account?.id,retry]);
  const connect = async event => {
    event.preventDefault();if(!confirmed || lock.current)return;
    lock.current=true;setBusy(true);setState(current=>({...current,error:''}));
    try{
      const data=await apiRequest(connectionPath,{method:'POST',body:JSON.stringify({confirmed:true,consentVersion:1})});
      if(!data.connected || data.account?.id!==account.id)throw new Error('The connection could not be confirmed. Please try again.');
      if(alive.current)setState({loading:false,...data,error:''});
    }catch(failure){if(alive.current){if(failure.status===401)signIn();else setState(current=>({...current,error:failure.message}));}}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  };
  if(state.connected)return <>{typeof children === 'function' ? children(state.feed || null) : children}<LoopAuraController account={account} onAccountUpdated={onAccountUpdated}/></>;
  return <main className="loop-app loop-connection-page">
    <section className="loop-connection-card" aria-labelledby="loop-connect-title" aria-busy={state.loading||busy}>
      <div className="loop-connection-brand" aria-hidden="true"><span className="loop-brand-mark">G</span><span>↔</span><span className="loop-brand-mark">G<small>LOOP</small></span></div>
      <span className="loop-kicker">Your Glean account, connected</span>
      <h1 id="loop-connect-title">Connect your Glean account with Glean Loop?</h1>
      {state.loading ? <div className="loop-workspace-status" role="status"><span className="loop-loading-dot"/>Checking your account…</div> : state.account ? <>
        <div className="loop-connection-account">{state.account.avatarUrl ? <img className="loop-avatar" src={state.account.avatarUrl} alt=""/> : <span className="loop-avatar">{state.account.username.slice(0,2)}</span>}<div><strong>{state.account.username}</strong><small>Connecting this signed-in Glean account</small></div></div>
        <ul className="loop-connection-details"><li>Use the same username, profile picture, bio, and badges as Glean. Profile changes stay shared.</li><li>Posts, comments, and your Loop profile are visible to other signed-in Loop users.</li><li>Your existing Loop posts and follows stay with this account. Your Glean DMs, calls, and server chats are not posted to Loop.</li><li>There’s no new password. This connection is saved to your account, so you only need to confirm once.</li></ul>
        <form onSubmit={connect}><label className="loop-connection-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/><span>I’ve reviewed the information above and want to connect this Glean account to Glean Loop.</span></label>
          {state.error ? <p className="loop-inline-error" role="alert">{state.error}</p> : null}
          <div className="loop-connection-actions"><button className="loop-secondary-button" type="button" disabled={busy} onClick={()=>goTo(ROUTES.APP)}>Not now</button><button className="loop-primary-button" type="submit" disabled={!confirmed||busy}>{busy ? 'Connecting…' : 'Connect and continue'}</button></div>
        </form>
      </> : <div className="loop-workspace-status" role="alert"><p>{state.error || 'Your account could not be checked.'}</p><button className="loop-secondary-button" type="button" onClick={()=>setRetry(value=>value+1)}>Try again</button><button className="loop-secondary-button" type="button" onClick={()=>goTo(ROUTES.APP)}>Back to Glean</button></div>}
    </section>
  </main>;
}
