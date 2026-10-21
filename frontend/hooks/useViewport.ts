'use client';
import { useEffect, useState } from 'react';

/** Mirrors the prototype's breakpoints (isMobile < 900, tablet < 1240, right rail ≥ 1120). */
export function useViewport() {
  const [vw, setVw] = useState(1440);
  useEffect(() => {
    const on = () => setVw(window.innerWidth);
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const isMobile = vw < 900;
  const isTablet = vw >= 900 && vw < 1240;
  const narrow = vw < 1420;
  const showRight = !isMobile && !isTablet && vw >= 1120;
  return { vw, isMobile, isTablet, narrow, showRight };
}
