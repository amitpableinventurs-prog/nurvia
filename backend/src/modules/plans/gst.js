// GST state codes (the first two digits of a GSTIN), used to choose CGST + SGST (same state) or IGST.
const STATES = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  10: 'Bihar',
  11: 'Sikkim',
  12: 'Arunachal Pradesh',
  13: 'Nagaland',
  14: 'Manipur',
  15: 'Mizoram',
  16: 'Tripura',
  17: 'Meghalaya',
  18: 'Assam',
  19: 'West Bengal',
  20: 'Jharkhand',
  21: 'Odisha',
  22: 'Chhattisgarh',
  23: 'Madhya Pradesh',
  24: 'Gujarat',
  26: 'Dadra and Nagar Haveli and Daman and Diu',
  27: 'Maharashtra',
  29: 'Karnataka',
  30: 'Goa',
  31: 'Lakshadweep',
  32: 'Kerala',
  33: 'Tamil Nadu',
  34: 'Puducherry',
  35: 'Andaman and Nicobar Islands',
  36: 'Telangana',
  37: 'Andhra Pradesh',
  38: 'Ladakh',
};

const normalise = (name) => name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
const ALIASES = { orissa: '21', pondicherry: '34', delhincr: '07', newdelhi: '07', nctofdelhi: '07', jammuandkashmir: '01', andamanandnicobar: '35', damananddiu: '26', dadraandnagarhaveli: '26' };
const byName = new Map([...Object.entries(STATES).map(([code, name]) => [normalise(name), code.padStart(2, '0')]), ...Object.entries(ALIASES)]);

export const stateName = (code) => (code ? STATES[code] ?? STATES[Number(code)] : undefined);

// A GSTIN's state code, or the code for a state name typed in an address.
export function stateCodeOf({ gstin, state } = {}) {
  if (gstin && /^\d{2}/.test(gstin)) return gstin.slice(0, 2);
  if (state) return byName.get(normalise(state));
  return undefined;
}

// Splits GST on a taxable amount. Supply within one state is CGST + SGST, half each; across states
// it is IGST. When either state is unknown the supply is treated as within the supplier's state.
export function gstSplit(taxablePaise, ratePct, supplierState, recipientState) {
  const gst = Math.round((taxablePaise * ratePct) / 100);
  const interState = Boolean(supplierState && recipientState && supplierState !== recipientState);
  if (interState) return { cgstPaise: 0, sgstPaise: 0, igstPaise: gst, gstPaise: gst, interState };
  const cgst = Math.floor(gst / 2);
  return { cgstPaise: cgst, sgstPaise: gst - cgst, igstPaise: 0, gstPaise: gst, interState };
}

// Indian financial year (April to March) of a date in IST, as "26-27".
export function financialYear(date) {
  const ist = new Date(date.getTime() + 330 * 60_000);
  const start = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}
