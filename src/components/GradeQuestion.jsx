import { GRADE_OPTIONS } from '../app/grade';

function CheckMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 8.4 6.1 11.2 12.8 4.4" />
    </svg>
  );
}

export default function GradeQuestion({ value, onChange, name = 'grade' }) {
  const belowSelected = value === 'below_hs';

  return (
    <fieldset className="grade-question">
      <legend>What grade are you in?</legend>
      <div className="grade-options" role="radiogroup" aria-label="What grade are you in?">
        {GRADE_OPTIONS.map((item) => {
          const selected = value === item.id;
          const dimmed = belowSelected && item.id !== 'below_hs';
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              name={name}
              className={`grade-option${selected ? ' is-selected' : ''}${dimmed ? ' is-dimmed' : ''}`}
              aria-checked={selected}
              onClick={() => onChange(item.id)}
            >
              <span className={`grade-check${selected ? ' is-on' : ''}`}>
                {selected ? <CheckMark /> : null}
              </span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
