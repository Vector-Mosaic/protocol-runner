import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number
}

function Icon({ size = 16, ...props }: IconProps) {
  return <svg width={size} height={size} viewBox="0 0 16 16" {...props} />
}

export const Activity = Icon
export const AlertTriangle = Icon
export const CheckCircle2 = Icon
export const FileText = Icon
export const Pause = Icon
export const Play = Icon
export const RefreshCw = Icon
export const RotateCcw = Icon
export const Square = Icon
export const XCircle = Icon
