#!/bin/bash

# Script to identify unused image files in the codebase

# Create a list of all image files from the unused_assets.txt
IMAGE_FILES=$(cat unused_assets.txt | grep -E "\.(png|jpg|jpeg|svg|mp4)$")

echo "Checking for references to the following image files:"
echo "$IMAGE_FILES"
echo ""

UNUSED_IMAGES=()

for image_file in $IMAGE_FILES; do
    # Get just the filename without path
    filename=$(basename "$image_file")
    
    # Search for this filename in the codebase across different file types
    count=$(grep -r "$filename" . --include="*.{js,ts,jsx,tsx,json,html,css,md}" 2>/dev/null | wc -l)
    
    echo "File: $filename"
    echo "References found: $count"
    
    if [ "$count" -eq 0 ]; then
        echo "UNREFERENCED - This file is not used in the codebase"
        UNUSED_IMAGES+=("$image_file")
    else
        echo "REFERENCED - This file is used in the codebase"
    fi
    echo ""
done

echo "=== SUMMARY ==="
echo "The following files are not referenced in the codebase:"
for unused in "${UNUSED_IMAGES[@]}"; do
    echo "$unused"
done