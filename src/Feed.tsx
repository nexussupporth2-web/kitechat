import Profile from './Profile.tsx';

/** Stories & Reels page: just your profile with its album. */
export default function Feed({ me }: { me: string }) {
  return <Profile userId={me} isMe />;
}
