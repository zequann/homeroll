/** A "card that says what it is" (design §1): a quiet row, no button, never looks pressable. */
export function PlaceholderRow({ name, caption }: { name: string; caption: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "var(--s-3) 0" }}>
      <span className="ink-2">{name}</span>
      <span className="t-caption ink-3">{caption}</span>
    </div>
  );
}
