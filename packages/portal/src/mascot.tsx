import React from 'react';

export type MascotMood = 'idle' | 'greeting' | 'thinking' | 'success';

/** Original Dogfood artwork. The static brand assets are exported from this component. */
export function DogFace() {
  return (
    <g className="dog-head">
      <g className="dog-ear dog-ear-left">
        <path d="M43 35C25 24 11 36 10 57c-1 18 6 39 18 37 12-2 15-30 21-43Z" fill="#84512E" />
        <path
          d="M30 43c-9 2-12 16-9 29"
          fill="none"
          stroke="#AC7344"
          strokeWidth="6"
          strokeLinecap="round"
        />
      </g>
      <g className="dog-ear dog-ear-right">
        <path d="M85 35c18-11 32 1 33 22 1 18-6 39-18 37-12-2-15-30-21-43Z" fill="#84512E" />
        <path
          d="M98 43c9 2 12 16 9 29"
          fill="none"
          stroke="#AC7344"
          strokeWidth="6"
          strokeLinecap="round"
        />
      </g>
      <path
        d="M64 22c26 0 42 21 42 48 0 29-17 44-42 44S22 99 22 70c0-27 16-48 42-48Z"
        fill="#F4BD42"
      />
      <path
        d="M48 29c5-5 14-8 21-7l-5 11 13-5"
        fill="none"
        stroke="#FFE29B"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <ellipse cx="64" cy="88" rx="28" ry="21" fill="#FFF0CC" />
      <path d="M56 79q8-5 16 0c0 7-5 11-8 11s-8-4-8-11Z" fill="#18243B" />
      <path
        d="M64 89v5m-12-1q5 8 12 1 7 7 12-1"
        fill="none"
        stroke="#18243B"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <g className="dog-shades">
        <path
          d="m25 51 3 18c1 7 8 11 16 10 10-1 14-7 15-17h10c1 10 5 16 15 17 8 1 15-3 16-10l3-18H25Z"
          fill="#18243B"
        />
        <path
          d="M24 52h80M59 59q5-3 10 0"
          fill="none"
          stroke="#18243B"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <path
          d="m35 57 8 0-9 13m46-13h8l-9 13"
          fill="none"
          stroke="#6B8CC5"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </g>
    </g>
  );
}

export function Mascot({
  size = 40,
  mood = 'idle',
  label,
}: {
  size?: number;
  mood?: MascotMood;
  label?: string;
}) {
  return (
    <svg
      className="dog-mascot"
      data-mood={mood}
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <DogFace />
    </svg>
  );
}

export function Wordmark() {
  return <span className="dog-wordmark">dogfood</span>;
}
