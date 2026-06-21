"use client";
import { useEffect, useRef, useState } from "react";

// Animates only the dollar integers of the hero total. The "$" sign and the
// cents live outside this component and never move. Reduced-motion users (and
// JS-off / SSR) get the final value immediately — no rAF, no flash.
export function CountUp({ value }: { value: number }) {
  // Initial state = final value so SSR and first client render match (no
  // hydration mismatch); the effect restarts from 0 only when motion is allowed.
  const [n, setN] = useState(value);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const hero = ref.current?.closest(".hero");
    const settle = () => hero?.classList.add("is-settled");

    if (reduce || value <= 0) {
      setN(value);
      settle();
      return;
    }

    let raf = 0;
    const dur = 900;
    let startTs = 0;
    const step = (ts: number) => {
      if (!startTs) startTs = ts;
      const p = Math.min(1, (ts - startTs) / dur);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      setN(Math.round(value * eased));
      if (p < 1) {
        raf = requestAnimationFrame(step);
      } else {
        setN(value);
        settle();
      }
    };
    setN(0);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <span className="dollars" ref={ref}>
      {n.toLocaleString("en-US")}
    </span>
  );
}
