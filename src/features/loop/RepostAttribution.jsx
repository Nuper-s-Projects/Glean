import './RepostAttribution.css';
import VerifiedMark from '../../components/VerifiedMark';

export default function RepostAttribution({ post }) {
  if (!post.originalPostId) return null;
  const original = post.originalPost;
  if (!original?.author?.username) {
    return <span className="loop-repost-label">↻ Original post unavailable</span>;
  }
  return (
    <a className="loop-repost-label" href={`/loop?post=${original.id}`}>
      ↻ Reposted from @{original.author.username}{original.author.verified ? <VerifiedMark /> : null}
    </a>
  );
}
