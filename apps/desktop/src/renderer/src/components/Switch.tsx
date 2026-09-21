/** An on/off switch (role="switch"). */
export function Switch({
  checked,
  label,
  testId,
  onChange,
}: {
  checked: boolean;
  label: string;
  testId?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? 'bg-indigo-600' : 'bg-neutral-300 dark:bg-neutral-700'
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
          checked ? 'left-4.5' : 'left-0.5'
        }`}
      />
    </button>
  );
}
