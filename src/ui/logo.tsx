// Logo —— 5 行方块 E + ▶_（spec §8.3）。纯 █ 字符跨终端一致。
import { Box, Text } from 'ink';
import { T } from './theme.js';

export function Logo(): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={T.brand}>███████</Text>
      <Text color={T.brand}>█</Text>
      <Text>
        <Text color={T.brand}>█████   </Text>
        <Text color={T.accent}>▶</Text>
        <Text color={T.muted}>_</Text>
      </Text>
      <Text color={T.brand}>█</Text>
      <Text color={T.brand}>███████</Text>
    </Box>
  );
}
