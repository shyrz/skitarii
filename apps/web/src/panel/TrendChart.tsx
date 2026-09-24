import type { DailyCountsDto, PanelSeriesPointDto } from '../api.js'

/**
 * 趋势图：手写 SVG 多序列折线图（不引入图表库，约束见 phase2-spec §4）。
 * 四条序列共用一套纵轴；横轴只标首尾日期，手机上不挤刻度。
 */

const SERIES: { key: keyof DailyCountsDto; label: string; color: string }[] = [
  { key: 'messageCount', label: '消息', color: 'var(--tone-notice)' },
  { key: 'actionCount', label: '处置', color: 'var(--tone-caution)' },
  { key: 'appealCount', label: '申诉', color: 'var(--tone-danger)' },
  { key: 'overturnedCount', label: '撤销', color: 'var(--tone-success)' },
]

/* viewBox 坐标系：左侧留给纵轴刻度，底部留给首尾日期 */
const W = 320
const H = 168
const PAD_LEFT = 30
const PAD_RIGHT = 8
const PAD_TOP = 10
const PAD_BOTTOM = 22
const INNER_W = W - PAD_LEFT - PAD_RIGHT
const INNER_H = H - PAD_TOP - PAD_BOTTOM

/** 纵轴上限取 1/2/5×10ⁿ 的整齐值，全零时托底为 5，避免除零与贴顶的线。 */
function niceMax(value: number): number {
  if (value <= 5) return 5
  const pow = 10 ** Math.floor(Math.log10(value))
  const n = value / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * pow
}

/** 'YYYY-MM-DD' → 'M/D'；格式不符时原样返回。 */
function axisDate(date: string): string {
  const parts = date.split('-')
  const month = parts[1]
  const day = parts[2]
  return month !== undefined && day !== undefined ? `${Number(month)}/${Number(day)}` : date
}

export function TrendChart({ points }: { points: PanelSeriesPointDto[] }) {
  if (points.length === 0) {
    return <p className="empty-state">这个时间段还没有统计数据。</p>
  }

  const max = niceMax(
    Math.max(0, ...points.map((p) => Math.max(p.messageCount, p.actionCount, p.appealCount, p.overturnedCount))),
  )
  const x = (index: number): number =>
    PAD_LEFT + (points.length <= 1 ? INNER_W / 2 : (index * INNER_W) / (points.length - 1))
  const y = (value: number): number => PAD_TOP + (1 - value / max) * INNER_H

  const linePath = (key: keyof DailyCountsDto): string =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ')

  const ticks = [0, Math.round(max / 2), max]
  const first = points[0]
  const last = points[points.length - 1]

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="四类计数趋势图">
        {ticks.map((v) => (
          <g key={v}>
            <line className="chart-grid" x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={y(v)} y2={y(v)} />
            <text className="chart-tick" x={PAD_LEFT - 6} y={y(v) + 3} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {first !== undefined && (
          <text className="chart-tick" x={PAD_LEFT} y={H - 6}>
            {axisDate(first.date)}
          </text>
        )}
        {last !== undefined && points.length > 1 && (
          <text className="chart-tick" x={W - PAD_RIGHT} y={H - 6} textAnchor="end">
            {axisDate(last.date)}
          </text>
        )}
        {SERIES.map((s) =>
          points.length === 1 ? (
            <circle key={s.key} cx={x(0)} cy={y(points[0]?.[s.key] ?? 0)} r={3} fill={s.color} />
          ) : (
            <path
              key={s.key}
              d={linePath(s.key)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ),
        )}
      </svg>
      <figcaption className="chart-legend">
        {SERIES.map((s) => (
          <span className="legend-item" key={s.key} style={{ ['--tone' as string]: s.color }}>
            <span className="legend-dot" aria-hidden="true" />
            {s.label}
          </span>
        ))}
      </figcaption>
    </figure>
  )
}
