# App Splitting Strategy

This document outlines the strategy for splitting the application into multiple modules based on brand constants.

## Overview

The application is designed to support multiple brands with different configurations. To achieve this, we implement a brand constant system that allows each brand to have its own set of configurations.

## Structure

The brand constants are stored in:
`ezybiz/lib/brand-constants.js`

Each brand has its own configuration object with the following properties:
- `name`: Brand name
- `color`: Primary color for the brand
- `logo`: Logo URL or path
- `theme`: Theme settings

## Implementation

1. Create a configuration object for each brand in `brand-constants.js`
2. Use the brand identifier to select the appropriate configuration
3. Ensure all components use the brand constants for styling and content

## Updating Brand Constants

To update brand constants:
1. Modify the `brand-constants.js` file
2. Add new brand configurations if needed
3. Ensure all new configurations are consistent with the existing ones