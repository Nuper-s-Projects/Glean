import { nameStyleProps } from './nameStyle';
import VerifiedMark from '../../components/VerifiedMark';

export default function DisplayName({ user, children, className = '', suffix = '' }) {
  const label = children ?? user?.username ?? 'Unknown';
  const props = nameStyleProps(user?.nameStyle);
  return (
    <span className={`${props.className}${className ? ` ${className}` : ''}`} style={props.style}>
      {label}{user?.verified ? <VerifiedMark interactive reason={user.verifiedReason || 'Verified by Nuper.'} /> : null}{suffix}
    </span>
  );
}
