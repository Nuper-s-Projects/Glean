import { useEffect, useRef } from 'react';
import { startVisualLoop, subscribePageActivity } from '../../app/pageActivity';

function canElastic() {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function GleanButton({
  children,
  className = '',
  variant = 'primary',
  pressed = false,
  type = 'button',
  ...props
}) {
  const buttonRef = useRef(null);
  const glareRef = useRef(null);
  const hoverRef = useRef(false);
  const mouseRef = useRef({ x: 0, y: 0 });
  const loopRef = useRef(null);

  const stop = () => {
    hoverRef.current = false;
    loopRef.current?.();
    loopRef.current = null;
    if (buttonRef.current) buttonRef.current.style.transform = '';
    if (glareRef.current) glareRef.current.style.opacity = '0';
  };

  useEffect(() => {
    const unsubscribe = subscribePageActivity(activity => { if (activity !== 'active') stop(); });
    return () => { stop(); unsubscribe(); };
  }, []);

  const tick = () => {
    if (!hoverRef.current || !buttonRef.current || !canElastic()) {
      loopRef.current = null;
      return false;
    }
    const rect = buttonRef.current.getBoundingClientRect();
    const dx = mouseRef.current.x - (rect.left + rect.width / 2);
    const dy = mouseRef.current.y - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy);
    if (distance > 0) {
      const intensity = Math.min(distance / 280, 1) * 0.22;
      buttonRef.current.style.transform = `translate(${dx * 0.08}px, ${dy * 0.08}px) scaleX(${1 + Math.abs(dx / distance) * intensity}) scaleY(${1 + Math.abs(dy / distance) * intensity})`;
    }
  };

  return (
    <button
      {...props}
      ref={buttonRef}
      type={type}
      aria-pressed={pressed || undefined}
      className={`glean-btn${variant !== 'primary' ? ` is-${variant}` : ''}${pressed ? ' is-on' : ''}${className ? ` ${className}` : ''}`}
      onMouseEnter={(event) => {
        if (props.disabled) return;
        hoverRef.current = true;
        if (glareRef.current) glareRef.current.style.opacity = '0.7';
        if (canElastic() && !loopRef.current) loopRef.current = startVisualLoop(tick);
        props.onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        stop();
        props.onMouseLeave?.(event);
      }}
      onMouseMove={(event) => {
        mouseRef.current = { x: event.clientX, y: event.clientY };
        const glare = glareRef.current;
        if (glare) {
          const rect = event.currentTarget.getBoundingClientRect();
          glare.style.left = `${event.clientX - rect.left}px`;
          glare.style.top = `${event.clientY - rect.top}px`;
        }
        props.onMouseMove?.(event);
      }}
    >
      <span className="glean-btn-glare" ref={glareRef} aria-hidden="true" />
      <span className="glean-btn-label">{children}</span>
    </button>
  );
}
