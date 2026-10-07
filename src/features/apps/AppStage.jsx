import { useState } from 'react';
import { CommunityAvatar } from '../community/CommunityAvatar';
import { CloseIcon } from '../dm/icons';
import { appById } from './catalog';
import WhiteboardApp from './whiteboard/WhiteboardApp';
import GarticApp from './gartic/GarticApp';

export default function AppStage({
  appId,
  scopeKey,
  session,
  snapshot,
  state,
  isHost,
  accountId,
  sendOp,
  subscribeOps,
  onLeave,
  onEnd,
  error,
}) {
  const [notice, setNotice] = useState('');
  const app = appById(appId);
  const participants = session?.participants || [];

  return (
    <section className="glean-app-stage" aria-label={app?.name || 'App'}>
      <header>
        <span className="glean-app-stage-title">
          <strong>{app?.name || 'App'}</strong>
          <small>{participants.length} in app</small>
        </span>
        <span className="glean-app-stage-people">
          {participants.slice(0, 6).map((person) => <CommunityAvatar key={person.id} user={person} small interactive={false} />)}
        </span>
        <span className="glean-app-stage-actions">
          {isHost ? <button type="button" onClick={onEnd}>End</button> : null}
          <button type="button" onClick={onLeave} aria-label="Leave app" title="Leave app"><CloseIcon /></button>
        </span>
      </header>
      {appId === 'whiteboard' ? (
        <WhiteboardApp
          scopeKey={scopeKey}
          snapshot={snapshot}
          sendOp={sendOp}
          subscribeOps={subscribeOps}
          accountId={accountId}
          notice={notice || error}
          onNotice={setNotice}
        />
      ) : null}
      {appId === 'gartic' ? (
        <GarticApp
          scopeKey={scopeKey}
          state={state}
          session={session}
          isHost={isHost}
          accountId={accountId}
          sendOp={sendOp}
          notice={notice || error}
          onNotice={setNotice}
        />
      ) : null}
    </section>
  );
}
