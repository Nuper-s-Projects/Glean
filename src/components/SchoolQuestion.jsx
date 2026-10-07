import { useMemo, useState } from 'react';
import { SCHOOL_SKIP_ID, searchSchools } from '../app/laredoSchools';

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

export default function SchoolQuestion({ value, onChange, grade, name = 'school' }) {
  const [query, setQuery] = useState('');
  const schools = useMemo(() => searchSchools(grade, query), [grade, query]);
  const skipSelected = value === SCHOOL_SKIP_ID;

  return (
    <fieldset className="grade-question school-question">
      <legend>What school do you go to?</legend>
      <input
        className="school-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search Laredo schools"
        autoComplete="off"
        spellCheck="false"
      />
      <div className="school-options" role="radiogroup" aria-label="What school do you go to?">
        <button
          type="button"
          role="radio"
          name={name}
          className={`grade-option school-option school-skip${skipSelected ? ' is-selected' : ''}`}
          aria-checked={skipSelected}
          onClick={() => onChange(SCHOOL_SKIP_ID)}
        >
          <span className={`grade-check${skipSelected ? ' is-on' : ''}`}>
            {skipSelected ? <CheckMark /> : null}
          </span>
          <span className="school-swatches is-empty" aria-hidden="true" />
          <span>I wish to not respond</span>
        </button>
        <div className="school-list">
          {schools.map((item) => {
            const selected = value === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                name={name}
                className={`grade-option school-option${selected ? ' is-selected' : ''}`}
                aria-checked={selected}
                style={item.hex[0] ? { '--school-accent': item.hex[0] } : undefined}
                onClick={() => onChange(item.id)}
              >
                <span className={`grade-check${selected ? ' is-on' : ''}`}>
                  {selected ? <CheckMark /> : null}
                </span>
                <Swatches hex={item.hex} />
                <span className="school-copy">
                  <span>{item.name}</span>
                  {item.mascot ? <small>{item.mascot}</small> : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </fieldset>
  );
}
