export interface SupplierPicChoice { value: string; label: string; disabled: boolean }

/** The server roster is the only source of selectable names; current legacy names stay visible. */
export function supplierPicChoices(options: readonly string[], current: string): SupplierPicChoice[] {
  const names = [...new Set(options.map(name => name.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const value = current.trim();
  return [
    { value: '', label: 'UNASSIGNED', disabled: false },
    ...(value && !names.includes(value) ? [{ value, label: value, disabled: true }] : []),
    ...names.map(name => ({ value: name, label: name, disabled: false })),
  ];
}

export function isSelectableSupplierPic(value: string, options: readonly string[]): boolean {
  return value.trim() === '' || options.some(name => name.trim() === value.trim());
}
