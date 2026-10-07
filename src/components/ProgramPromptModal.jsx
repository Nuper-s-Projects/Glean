import { useState } from 'react';
import { updateAccountProgram } from '../app/dmApi';
import { programDraftFromAccount } from '../app/programs';
import ProgramQuestion from './ProgramQuestion';

export default function ProgramPromptModal({ account, onSaved }) {
  const [programs, setPrograms] = useState(() => programDraftFromAccount(account));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!programs.length) {
      setError('Pick a program, or choose “Neither in these programs”.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      onSaved(await updateAccountProgram(programs));
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  };

  return (
    <div className="grade-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="program-modal-title">
      <form className="grade-modal" onSubmit={save}>
        <div className="grade-modal-head">
          <span className="grade-modal-step">Programs</span>
          <h2 id="program-modal-title">Are you in any of these programs?</h2>
          <p>Pick any that apply, or skip.</p>
        </div>
        <div className="grade-modal-body">
          <ProgramQuestion
            value={programs}
            onChange={(value) => { setPrograms(value); setError(''); }}
            name="existing-program"
          />
        </div>
        <p className="grade-modal-error" role="alert">{error}</p>
        <div className="grade-modal-actions">
          <button className="primary-button" type="submit" disabled={!programs.length || busy}>{busy ? 'Saving…' : 'Finish'}</button>
        </div>
      </form>
    </div>
  );
}
