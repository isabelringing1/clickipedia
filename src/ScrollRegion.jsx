import { useCallback, useLayoutEffect, useRef, useState } from "react";

function ScrollRegion({ children, className = "", scrollPositionRef }) {
  const scrollRef = useRef(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);

  const updateFades = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    setCanScrollUp(element.scrollTop > 1);
    setCanScrollDown(
      element.scrollTop + element.clientHeight < element.scrollHeight - 1,
    );
  }, []);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element && scrollPositionRef) {
      scrollPositionRef.current = element.scrollTop;
    }
    updateFades();
  }, [scrollPositionRef, updateFades]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !scrollPositionRef) return;
    element.scrollTop = scrollPositionRef.current;
    updateFades();
    return () => {
      scrollPositionRef.current = element.scrollTop;
    };
  }, [scrollPositionRef, updateFades]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    updateFades();
    const resizeObserver = new ResizeObserver(updateFades);
    resizeObserver.observe(element);
    if (element.firstElementChild) {
      resizeObserver.observe(element.firstElementChild);
    }

    return () => resizeObserver.disconnect();
  }, [children, updateFades]);

  return (
    <div className={`scroll-region ${className}`}>
      <div
        className="scroll-region-content"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        {children}
      </div>
      {canScrollUp && <div className="scroll-fade scroll-fade-top"></div>}
      {canScrollDown && <div className="scroll-fade scroll-fade-bottom"></div>}
    </div>
  );
}

export default ScrollRegion;
