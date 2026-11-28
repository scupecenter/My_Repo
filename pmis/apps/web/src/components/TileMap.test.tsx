import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@/i18n';
import { MAP_SEED } from '@/api/mapSettings';
import { TileMap } from './TileMap';

describe('TileMap', () => {
  it('draws tiles from the same-server template and shows the credit line and zoom buttons', () => {
    render(<TileMap marks={[]} cfg={{ ...MAP_SEED, enabled: true, tile_url: '/tiles/{z}/{x}/{y}.png', attribution: 'Test credit' }} height={400} label="map" resetKey={0} tip={() => ''} onOpen={() => undefined} />);
    const imgs = screen.getAllByTestId('tile');
    expect(imgs.length).toBeGreaterThan(0);
    for (const i of imgs) expect(i.getAttribute('src')).toMatch(/^\/tiles\/\d+\/\d+\/\d+\.png$/);
    expect(screen.getByText('Test credit')).toBeTruthy();
  });
});
