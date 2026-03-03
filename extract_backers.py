#!/usr/bin/env python3
"""
Extract Ethereum addresses from Circles backer JSON files and convert to CSV format.
"""

import json
import csv
from pathlib import Path

def extract_addresses_from_json(json_file_path):
    """Extract all 'id' addresses from the Avatar array in the JSON file."""
    addresses = []
    
    try:
        with open(json_file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        # Navigate to the Avatar array
        avatars = data.get('data', {}).get('Avatar', [])
        
        for avatar in avatars:
            if 'id' in avatar and avatar['id']:
                address = avatar['id'].strip()
                # Validate it's an Ethereum address
                if address.startswith('0x') and len(address) == 42:
                    addresses.append(address)
        
        print(f"Extracted {len(addresses)} addresses from {json_file_path}")
        return addresses
        
    except Exception as e:
        print(f"Error processing {json_file_path}: {e}")
        return []

def save_addresses_to_csv(addresses, output_file_path):
    """Save addresses to CSV file with 'trustee' header."""
    try:
        with open(output_file_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(['trustee'])  # Header
            for address in addresses:
                writer.writerow([address])
        
        print(f"Saved {len(addresses)} addresses to {output_file_path}")
        
    except Exception as e:
        print(f"Error saving to {output_file_path}: {e}")

def main():
    """Main function to process both JSON files and create CSV outputs."""
    
    # File paths
    base_dir = Path('.')
    
    # Input files
    backers_json = base_dir / 'backers-raw-061125.json'
    extended_backers_json = base_dir / 'extendedBackers-raw-061125.json'
    
    # Output files
    backers_csv = base_dir / 'backers_061125.csv'
    extended_backers_csv = base_dir / 'extended_backers_061125.csv'
    
    print("Starting extraction of addresses from JSON files...")
    print("=" * 50)
    
    # Process regular backers file
    if backers_json.exists():
        print(f"\nProcessing: {backers_json}")
        addresses = extract_addresses_from_json(backers_json)
        if addresses:
            save_addresses_to_csv(addresses, backers_csv)
        else:
            print("No addresses found!")
    else:
        print(f"File not found: {backers_json}")
    
    # Process extended backers file
    if extended_backers_json.exists():
        print(f"\nProcessing: {extended_backers_json}")
        addresses = extract_addresses_from_json(extended_backers_json)
        if addresses:
            save_addresses_to_csv(addresses, extended_backers_csv)
        else:
            print("No addresses found!")
    else:
        print(f"File not found: {extended_backers_json}")
    
    print("\n" + "=" * 50)
    print("Extraction completed!")

if __name__ == "__main__":
    main()