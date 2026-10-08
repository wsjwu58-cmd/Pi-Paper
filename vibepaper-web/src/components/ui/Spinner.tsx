export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <div
      className={`${className} animate-spin rounded-full border-2 border-black/15 border-t-black/80`}
      role="status"
      aria-label="加载中"
    />
  )
}
