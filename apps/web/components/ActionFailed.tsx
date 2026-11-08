/** Shown when a server action threw (usually a busy testnet RPC). The page has been re-read. */
export function ActionFailed({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="t-caption ink-2" role="alert">
      That did not finish: the testnet RPC is busy. The page now shows what went through. Wait a
      moment, then try again.
    </p>
  );
}
