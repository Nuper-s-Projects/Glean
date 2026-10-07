import { useState } from 'react';
import { updateAccountGrade, updateAccountSchool } from '../app/dmApi';
import { schoolFitsGrade } from '../app/laredoSchools';
import GradeQuestion from './GradeQuestion';
import SchoolQuestion from './SchoolQuestion';

export default function GradePromptModal({ account, onSaved }) {
  const [step, setStep] = useState(account?.grade ? 2 : 1);
  const [grade, setGrade] = useState(account?.grade || '');
  const [school, setSchool] = useState(account?.school && schoolFitsGrade(account.school, account?.grade || '') ? account.school : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const next = () => {
    if (!grade) {
      setError('Pick your grade to continue.');
      return;
    }
    setError('');
    setStep(2);
  };

  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (step === 1) {
      next();
      return;
    }
    if (!grade) {
      setStep(1);
      setError('Pick your grade to continue.');
      return;
    }
    if (!school) {
      setError('Pick a school, or choose “I wish to not respond”.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      let account = await updateAccountGrade(grade);
      account = await updateAccountSchool(school);
      onSaved(account);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  };

  return (
    <div className="grade-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="grade-modal-title">
      <form className="grade-modal" onSubmit={save}>
        <div className="grade-modal-head">
          <span className="grade-modal-step">Step {step} of 2</span>
          <h2 id="grade-modal-title">{step === 1 ? 'What grade are you in?' : 'Which school do you go to?'}</h2>
          <p>{step === 1 ? 'This helps us show you the right people and classes.' : 'Search for your campus, or skip if you’d rather not say.'}</p>
          <div className="grade-modal-track" aria-hidden="true">
            <span className="is-on" />
            <span className={step === 2 ? 'is-on' : ''} />
          </div>
        </div>

        <div className="grade-modal-body">
          {step === 1 ? (
            <GradeQuestion
              value={grade}
              onChange={(value) => {
                setGrade(value);
                setSchool((current) => (schoolFitsGrade(current, value) ? current : ''));
                setError('');
              }}
              name="existing-grade"
            />
          ) : (
            <SchoolQuestion
              value={school}
              grade={grade}
              onChange={(value) => { setSchool(value); setError(''); }}
              name="existing-school"
            />
          )}
        </div>

        <p className="grade-modal-error" role="alert">{error}</p>

        <div className="grade-modal-actions">
          {step === 2 ? (
            <button className="secondary-button grade-modal-back" type="button" onClick={() => { setError(''); setStep(1); }} disabled={busy}>Back</button>
          ) : null}
          {step === 1 ? (
            <button className="primary-button" type="button" onClick={next} disabled={!grade}>Next</button>
          ) : (
            <button className="primary-button" type="submit" disabled={!school || busy}>{busy ? 'Saving…' : 'Finish'}</button>
          )}
        </div>
      </form>
    </div>
  );
}
