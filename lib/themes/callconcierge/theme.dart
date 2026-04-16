import 'package:flutter/material.dart';
import 'colors.dart';
import 'typography.dart';

class CallConciergeTheme {
  static final ThemeData theme = ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.light(
      primary: CallConciergeColors.primary,
      primaryContainer: CallConciergeColors.primaryLight,
      secondary: CallConciergeColors.secondary,
      secondaryContainer: CallConciergeColors.secondaryLight,
      surface: CallConciergeColors.background,
      surfaceVariant: CallConciergeColors.backgroundDark,
      onPrimary: CallConciergeColors.background,
      onSecondary: CallConciergeColors.background,
      onSurface: CallConciergeColors.textPrimary,
      error: CallConciergeColors.error,
      onError: CallConciergeColors.background,
    ),
    textTheme: TextTheme(
      displayLarge: CallConciergeTypography.heading1,
      displayMedium: CallConciergeTypography.heading2,
      displaySmall: CallConciergeTypography.heading3,
      titleLarge: CallConciergeTypography.subheading1,
      titleMedium: CallConciergeTypography.subheading2,
      bodyLarge: CallConciergeTypography.body1,
      bodyMedium: CallConciergeTypography.body2,
      labelLarge: CallConciergeTypography.caption,
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: CallConciergeColors.primary, // background color
        foregroundColor: CallConciergeColors.background, // text color
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8.0),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 24.0, vertical: 12.0),
      ),
    ),
    bottomNavigationBarTheme: BottomNavigationBarThemeData(
      selectedItemColor: CallConciergeColors.primary,
      unselectedItemColor: CallConciergeColors.textLight,
      backgroundColor: CallConciergeColors.background,
      type: BottomNavigationBarType.fixed,
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: CallConciergeColors.primary,
      foregroundColor: CallConciergeColors.background,
    ),
    dividerTheme: DividerThemeData(
      color: CallConciergeColors.divider,
      thickness: 1.0,
    ),
  );
}