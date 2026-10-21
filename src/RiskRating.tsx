export default function RiskRating({ value }: { value?: number }) {
  const valid = typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
  if (!valid) return <span>—</span>;
  return <div className="buyer-risk" role="meter" aria-label="Risk rating" aria-valuemin={1} aria-valuemax={5} aria-valuenow={value} aria-valuetext={`${value} of 5; 1 is lower risk, 5 is higher risk`}>
    <strong>{value} / 5</strong><div className="buyer-risk__scale" aria-hidden="true">{[1,2,3,4,5].map(score => <span key={score} data-selected={score === value}>{score}</span>)}</div><div className="buyer-risk__ends" aria-hidden="true"><span>Lower risk</span><span>Higher risk</span></div>
  </div>;
}
