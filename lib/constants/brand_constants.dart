// Brand constants for EzyBiz, EzyStaff and CallConcierge themes
class BrandConstants {
  // Brand names
  static const String EZYBIZ = 'EzyBiz';
  static const String EZYSTAFF = 'EzyStaff';
  static const String CALLCONCIERGE = 'CallConcierge';
  
  // Primary colors for each brand
  static const String EZYBIZ_PRIMARY = '#0055A4';
  static const String EZYSTAFF_PRIMARY = '#008080';
  static const String CALLCONCIERGE_PRIMARY = '#FFD700'; // Gold color
  
  // Shared theme values
  static const String PRIMARY_FONT = 'Roboto';
  static const String SECONDARY_FONT = 'Open Sans';
  
  // Brand-specific values
  static const Map<String, String> BRANDS = {
    EZYBIZ: EZYBIZ_PRIMARY,
    EZYSTAFF: EZYSTAFF_PRIMARY,
    CALLCONCIERGE: CALLCONCIERGE_PRIMARY,
  };
}