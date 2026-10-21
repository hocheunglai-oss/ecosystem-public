import { useId } from "react";
import { HARBOUR_ASSETS } from "./harbourAssets";
import "./CosulichBarge.css";

/** Reference-based Cosulich bunker barge illustration, permanently moored.
 * Only the surrounding water moves; the vessel has no gameplay state. */
export function CosulichBarge({ night = false, kind = "oil" }: { night?: boolean; kind?: "oil" | "lng" }) {
  const id = useId();
  const lng = kind === "lng";
  return <g className={`cosulich-barge${lng ? " cosulich-barge--lng" : ""}${night ? " cosulich-barge--night" : ""}`} data-cosulich-barge={lng ? "cosulich-lng" : "cosulich"} pointerEvents="none">
    <defs>
      {/* WebKit can report a CSS brightness filter on an SVG image without
          painting it. Native SVG colour filters keep mobile night lighting
          identical to the desktop harbour. Alpha stays unchanged. */}
      <filter id={`${id}-hull-tone`} colorInterpolationFilters="sRGB">
        <feColorMatrix type="saturate" values={night ? ".7" : ".88"} />
        <feComponentTransfer>
          <feFuncR type="linear" slope={night ? ".624" : ".96"} intercept={night ? "-.02" : ".02"} />
          <feFuncG type="linear" slope={night ? ".624" : ".96"} intercept={night ? "-.02" : ".02"} />
          <feFuncB type="linear" slope={night ? ".624" : ".96"} intercept={night ? "-.02" : ".02"} />
        </feComponentTransfer>
      </filter>
      <filter id={`${id}-shadow`} x="-10%" y="-30%" width="120%" height="160%" colorInterpolationFilters="sRGB">
        <feGaussianBlur stdDeviation={lng ? 2.3 : 3} />
      </filter>
      {lng && <>
        <clipPath id={`${id}-reflection-clip`}>
          <path d="M575 377 C598 389 639 399 677 410 C713 420 743 425 765 426 L769 447 C721 447 616 415 567 394Z" />
        </clipPath>
        <linearGradient id={`${id}-reflection-fade`} gradientUnits="userSpaceOnUse" x1="671" y1="407" x2="666" y2="423">
          <stop stopColor="white" stopOpacity=".8" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <mask id={`${id}-reflection-mask`} maskUnits="userSpaceOnUse" x="555" y="350" width="230" height="110">
          <rect x="555" y="350" width="230" height="110" fill={`url(#${id}-reflection-fade)`} />
        </mask>
        <filter id={`${id}-reflection`} x="-10%" y="-20%" width="120%" height="140%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency=".06 .45" numOctaves="2" seed="8" result="chop" />
          <feDisplacementMap in="SourceGraphic" in2="chop" scale="5" xChannelSelector="R" yChannelSelector="G" />
          <feGaussianBlur stdDeviation="1" />
        </filter>
      </>}
    </defs>
    {lng && <g clipPath={`url(#${id}-reflection-clip)`} mask={`url(#${id}-reflection-mask)`} className="cosulich-barge__reflection">
      <use href={`#${id}-hull`} transform="matrix(.876 .482 .482 -.876 -110.5 430.5)" filter={`url(#${id}-reflection)`} />
    </g>}
    <path className="cosulich-barge__shadow" d={lng
      ? "M575 374 C582 388 614 396 643 404 C686 418 727 430 763 431 Q770 430 769 422 L755 411 L589 363Z"
      : "M937 462 C939 478 966 485 1004 497 L1095 524 Q1144 537 1158 528 Q1167 523 1151 515 L959 457Z"} filter={`url(#${id}-shadow)`} />
    <path className="cosulich-barge__contact" d={lng
      ? "M575 373 C581 382 600 387 627 395 C664 406 697 415 728 422 Q750 426 763 427 Q767 426 766 421 L752 414 C718 413 674 398 635 386 L585 365Z"
      : "M939 465 C946 480 989 490 1021 500 L1087 519 Q1119 529 1152 526 L1154 520 L951 461Z"} />
    {lng && <g className="cosulich-barge__moorings" fill="none" strokeLinecap="round">
      <path d="M606 355 Q597 362 590 365 M720 382 Q732 394 746 397" />
    </g>}
    <image id={`${id}-hull`} href={lng ? HARBOUR_ASSETS.lng : HARBOUR_ASSETS.bunker}
      filter={`url(#${id}-hull-tone)`}
      x={lng ? 570 : 925} y={lng ? 328 : 407} width={lng ? 200 : 240} height={lng ? 100 : 120} />
  </g>;
}
