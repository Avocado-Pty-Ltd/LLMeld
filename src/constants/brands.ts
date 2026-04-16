export enum Brand {
  EZYBIZ = 'ezybiz',
  CALLCONCIERGE = 'callconcierge'
}

export const ALL_BRANDS = [
  Brand.EZYBIZ,
  Brand.CALLCONCIERGE
];

export const BRAND_DISPLAY_NAMES: Record<Brand, string> = {
  [Brand.EZYBIZ]: 'EzyBiz',
  [Brand.CALLCONCIERGE]: 'CallConcierge'
};