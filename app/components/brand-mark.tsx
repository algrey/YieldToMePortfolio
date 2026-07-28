type BrandMarkProps = {
  decorative?: boolean;
};

export function BrandMark({ decorative = true }: BrandMarkProps) {
  return (
    <span
      className="brand-mark"
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : "YieldToMe"}
    >
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
