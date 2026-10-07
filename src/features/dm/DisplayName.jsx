import { nameStyleProps } from './nameStyle';

export default function DisplayName({ user, children, className = '', suffix = '' }) {
  const label = children ?? user?.username ?? 'Unknown';
  const props = nameStyleProps(user?.nameStyle);
  return (
    <span className={`${props.className}${className ? ` ${className}` : ''}`} style={props.style}>
      {label}{suffix}
    </span>
  );
}
