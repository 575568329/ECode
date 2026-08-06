// 共享边框 props（spec §9.6-7.1）。
// ink 单边左边框：必须 borderStyle+"single" + 四个 borderXxx 显式控制，
// 单独 borderLeft 不渲染（M3.5 实测踩坑）。
// ChatView（用户/系统消息）+ BlockTool 共用此对象。
import type { BoxProps } from 'ink';

export const leftBorder: Pick<
  BoxProps,
  'borderStyle' | 'borderLeft' | 'borderTop' | 'borderBottom' | 'borderRight'
> = {
  borderStyle: 'single',
  borderLeft: true,
  borderTop: false,
  borderBottom: false,
  borderRight: false,
};
