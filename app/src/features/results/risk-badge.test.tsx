import { describe, expect, test } from '@jest/globals';

import { render, screen } from '@/test-utils/render';

import { RiskBadge } from './risk-badge';

describe('RiskBadge', () => {
  test('says the transfer holds', async () => {
    await render(<RiskBadge transferAtRisk={false} />);
    expect(screen.getByText('Transfer OK')).toBeTruthy();
  });

  test('warns when the transfer is at risk', async () => {
    await render(<RiskBadge transferAtRisk />);
    expect(screen.getByText('Transfer at risk')).toBeTruthy();
  });

  // `null` means there is no live data to judge by. It must not read as either
  // a pass or a warning.
  test('says there is no live data, rather than guessing', async () => {
    await render(<RiskBadge transferAtRisk={null} />);
    expect(screen.getByText('No realtime data')).toBeTruthy();
    expect(screen.queryByText('Transfer OK')).toBeNull();
    expect(screen.queryByText('Transfer at risk')).toBeNull();
  });
});
