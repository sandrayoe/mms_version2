import pandas as pd
import matplotlib.pyplot as plt
import numpy as np
import glob
import os

# Find the most recent impedance CSV file
csv_files = glob.glob('mms_impedance_*.csv')
if not csv_files:
    print("No impedance CSV files found!")
    exit()

# Sort by modification time and get the most recent
latest_file = max(csv_files, key=os.path.getmtime)
print(f"Processing file: {latest_file}")

# Read the CSV file
df = pd.read_csv(latest_file)

# Filter out invalid data (9999999 typically indicates no measurement)
df_valid = df[(df['impedance_data'] != 9999999) & (df['impedance_data_2'] != 9999999)]

print(f"Total measurements: {len(df)}")
print(f"Valid measurements: {len(df_valid)}")

# Create scatter plot with color coding by electrode_1
plt.figure(figsize=(12, 10))

# Define colors for each electrode (1-9)
colors = plt.cm.tab10(np.linspace(0, 0.9, 9))
electrode_colors = {i: colors[i-1] for i in range(1, 10)}

# Plot each electrode separately for color coding
for electrode in range(1, 10):
    df_electrode = df_valid[df_valid['electrode_1'] == electrode]
    if len(df_electrode) > 0:
        plt.scatter(df_electrode['impedance_data'], df_electrode['impedance_data_2'], 
                    alpha=0.7, s=50, edgecolors='black', linewidth=0.5, 
                    color=electrode_colors[electrode], label=f'Electrode {electrode}')

# Get the range for the y=x line
min_val = min(df_valid['impedance_data'].min(), df_valid['impedance_data_2'].min())
max_val = max(df_valid['impedance_data'].max(), df_valid['impedance_data_2'].max())

# Add y=x reference line (from 0 to max)
x_line = np.linspace(0, max_val, 100)
plt.plot(x_line, x_line, 'r--', linewidth=2, label='y = x (Perfect Agreement)')

# Labels and formatting
plt.xlabel('Impedance Data 1 (Ω)', fontsize=12)
plt.ylabel('Impedance Data 2 (Ω)', fontsize=12)
plt.title('Comparison of Impedance Measurements\n(Before vs During Stimulation)', fontsize=14, fontweight='bold')
plt.grid(True, alpha=0.3)
plt.legend(fontsize=10)

# Set axes to start from 0 and make them equal
plt.xlim(0, max_val * 1.05)
plt.ylim(0, max_val * 1.05)
plt.gca().set_aspect('equal', adjustable='box')
plt.tight_layout()

# Save the plot
output_filename = latest_file.replace('.csv', '_scatter.png')
plt.savefig(output_filename, dpi=300, bbox_inches='tight')
print(f"Plot saved as: {output_filename}")

plt.show()
