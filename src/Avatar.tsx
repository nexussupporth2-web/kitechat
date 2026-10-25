/** A round picture: the profile photo if there is one, otherwise the avatar letter or emoji. */
export default function Avatar({
  avatar,
  photoUrl,
  className = 'w-10 h-10 text-sm'
}: {
  avatar: string;
  photoUrl?: string | null;
  className?: string;
}) {
  return photoUrl ? (
    <img src={photoUrl} alt="" className={`${className} shrink-0 rounded-full object-cover`} />
  ) : (
    <div className={`${className} shrink-0 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center font-bold`}>{avatar}</div>
  );
}
