// Simple test script to verify brand constants are exported correctly
const brands = require('./src/constants/brands.ts');

console.log('Brand constants loaded successfully');
console.log('Available brands:', Object.keys(brands));

// Test if specific brand constants are defined
console.log('EZYBIZ constant:', brands.Brand.EZYBIZ);
console.log('CALLCONCIERGE constant:', brands.Brand.CALLCONCIERGE);

// Test if display names are defined
console.log('BRAND_DISPLAY_NAMES:', brands.BRAND_DISPLAY_NAMES);