/** The approved sculpted flag, repainted from the company artwork, on its original hill. */
export function HilltopSign() {
  return (
    <g className="marine-hill-sign" data-hill-sign="cosulich">
      <defs>
        <filter id="hill-sign-feather" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="2" />
        </filter>
        <mask id="hill-sign-patch" maskUnits="userSpaceOnUse" x="1086" y="167" width="122" height="123" style={{ maskType: "alpha" }}>
          <rect x="1094" y="175" width="106" height="107" rx="5" fill="white" filter="url(#hill-sign-feather)" />
        </mask>
      </defs>
      {/* Keep the cleaned harbour unchanged outside the sculpture and its footings. */}
      <image
        data-company-flag="sculpture"
        href="/marine/cosulich-hill-sculpture-v1.jpg"
        x="1060"
        y="148"
        width="178"
        height="173"
        preserveAspectRatio="xMidYMid meet"
        mask="url(#hill-sign-patch)"
      />
    </g>
  );
}
