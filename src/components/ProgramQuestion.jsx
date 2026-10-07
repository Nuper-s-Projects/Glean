import { PROGRAM_SKIP_ID, PROGRAMS } from '../app/programs';

function CheckMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 8.4 6.1 11.2 12.8 4.4" />
    </svg>
  );
}

function Swatches({ hex }) {
  const colors = hex || [];
  if (!colors.length) return <span className="school-swatches is-empty" aria-hidden="true" />;
  return (
    <span className="school-swatches" aria-hidden="true">
      {colors.slice(0, 3).map((color) => (
        <span
          key={color}
          className={`school-swatch${/^#(?:f{3}|f{6}|c0c0c0)$/i.test(color) ? ' is-light' : ''}`}
          style={{ background: color }}
        />
      ))}
    </span>
  );
}

export default function ProgramQuestion({ value, onChange, name = 'program' }) {
  const selected = Array.isArray(value) ? value : [];
  const skipSelected = selected.includes(PROGRAM_SKIP_ID);

  const toggle = (id) => {
    if (id === PROGRAM_SKIP_ID) {
      onChange([PROGRAM_SKIP_ID]);
      return;
    }
    const next = selected.filter((item) => item !== PROGRAM_SKIP_ID);
    onChange(next.includes(id) ? next.filter((item) => item !== id) : [...next, id]);
  };

  return (
    <fieldset className="grade-question school-question program-question">
      <legend>Are you in any of these programs?</legend>
      <div className="school-options" role="group" aria-label="Are you in any of these programs?">
        <button
          type="button"
          role="checkbox"
          name={name}
          className={`grade-option school-option school-skip${skipSelected ? ' is-selected' : ''}`}
          aria-checked={skipSelected}
          onClick={() => toggle(PROGRAM_SKIP_ID)}
        >
          <span className={`grade-check${skipSelected ? ' is-on' : ''}`}>
            {skipSelected ? <CheckMark /> : null}
          </span>
          <span className="school-swatches is-empty" aria-hidden="true" />
          <span>Neither in these programs</span>
        </button>
        <div className="school-list">
          {PROGRAMS.map((item) => {
            const on = !skipSelected && selected.includes(item.id);
            return (
              <button
                key={item.id}
                type="button"
                role="checkbox"
                name={name}
                className={`grade-option school-option${on ? ' is-selected' : ''}`}
                aria-checked={on}
                style={item.hex[0] ? { '--school-accent': item.hex[0] } : undefined}
                onClick={() => toggle(item.id)}
              >
                <span className={`grade-check${on ? ' is-on' : ''}`}>
                  {on ? <CheckMark /> : null}
                </span>
                <Swatches hex={item.hex} />
                <span className="school-copy">
                  <span>{item.name}</span>
                  <small>{item.tag}</small>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </fieldset>
  );
}
