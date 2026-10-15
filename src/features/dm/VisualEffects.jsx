import { Liquid as GooeyLiquid } from 'liquid-gooey';
import { isHardwareAccelerationEnabled } from '../../app/hardwareAcceleration';

export function Liquid({ children, blur, contrast, fill, filterPadding, ...props }) {
  if (isHardwareAccelerationEnabled()) return <GooeyLiquid {...props} blur={blur} contrast={contrast} fill={fill} filterPadding={filterPadding}>{children}</GooeyLiquid>;
  return <div {...props}>{children}</div>;
}

function LiquidItem({ children, x = 0, y = 0, scale = 1, radius, delay = 0, transition, ...props }) {
  if (isHardwareAccelerationEnabled()) return <GooeyLiquid.Item {...props} x={x} y={y} scale={scale} radius={radius} delay={delay} transition={transition}>{children}</GooeyLiquid.Item>;
  return <div {...props} style={{ borderRadius: radius, transform: `translate(${x}px, ${y}px) scale(${scale})`, transition: `transform ${transition?.duration ?? 0}ms ${transition?.ease || 'ease'} ${delay}ms`, ...props.style }}>{children}</div>;
}
Liquid.Item = LiquidItem;
