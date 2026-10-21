/** Explicit ECO port identities. Names are presentation/equality fields, never fuzzy identity. */
export const supplierPorts = [
  { id: 'port-singapore', code: 'SGSIN', countryCode: 'SG', countryName: 'Singapore', portName: 'Singapore' },
  { id: 'port-hong-kong', code: 'HKHKG', countryCode: 'HK', countryName: 'Hong Kong', portName: 'Hong Kong' },
  { id: 'port-rotterdam', code: 'NLRTM', countryCode: 'NL', countryName: 'Netherlands', portName: 'Rotterdam' },
  { id: 'port-fujairah', code: 'AEFJR', countryCode: 'AE', countryName: 'United Arab Emirates', portName: 'Fujairah' },
  { id: 'port-busan', code: 'KRPUS', countryCode: 'KR', countryName: 'South Korea', portName: 'Busan' },
  { id: 'port-tokyo', code: 'JPTYO', countryCode: 'JP', countryName: 'Japan', portName: 'Tokyo' },
  { id: 'port-chiba', code: '', countryCode: 'JP', countryName: 'Japan', portName: 'Chiba' },
  { id: 'port-yokohama', code: '', countryCode: 'JP', countryName: 'Japan', portName: 'Yokohama' },
  { id: 'port-osaka', code: '', countryCode: 'JP', countryName: 'Japan', portName: 'Osaka' },
  { id: 'port-ho-chi-minh', code: 'VNSGN', countryCode: 'VN', countryName: 'Vietnam', portName: 'Ho Chi Minh City' },
  { id: 'port-gibraltar', code: 'GIGIB', countryCode: 'GI', countryName: 'Gibraltar', portName: 'Gibraltar' },
] as const;
export type SupplierPort = typeof supplierPorts[number];
export const supplierPortById = (id: string): SupplierPort | undefined => supplierPorts.find(port => port.id === id);
export function supplierPortForLocation(location: { id: string; code: string; country: string }): SupplierPort | undefined {
  const code = location.code.replace(/\s/g, '').toUpperCase();
  const country = location.country.trim().toLowerCase();
  return supplierPorts.find(port => port.countryName.toLowerCase() === country
    && (code ? Boolean(port.code && port.code === code) : port.id === location.id));
}
