// 星形 spinner —— 工具运行态 + thinking loader 指示。80ms/帧循环。
import { useState, useEffect } from 'react';
import { Text } from 'ink';
import { SPINNER_FRAMES, T } from './theme.js';

interface SpinnerProps {
  /** 颜色 token hex，默认 brand。 */
  color?: string;
}

export function Spinner({ color = T.brand }: SpinnerProps): React.ReactElement {
  const frames = [...SPINNER_FRAMES];
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((v) => (v + 1) % frames.length), 80);
    return () => clearInterval(id);
  }, [frames.length]);
  return <Text color={color}>{frames[i]}</Text>;
}
