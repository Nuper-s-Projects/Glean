import { customBadgeTextColor } from '../../app/customBadges';

export default function CustomBadges({ badges, inline = false }) {
  if (!Array.isArray(badges) || !badges.length) return null;
  return (
    <span className={`dm-custom-badges${inline ? ' is-inline' : ''}`}>
      {badges.map((badge, index) => (
        <span
          className="dm-profile-badge is-custom"
          key={`${badge.label}-${index}`}
          style={{ '--custom-badge-background': badge.color, '--custom-badge-foreground': customBadgeTextColor(badge.color) }}
        >
          {badge.label}
        </span>
      ))}
    </span>
  );
}
