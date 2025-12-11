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

# Create figure with 3x3 subplots
fig, axes = plt.subplots(3, 3, figsize=(15, 15))
fig.suptitle('Impedance Comparison by Electrode 1\n(Before vs During Stimulation)', 
             fontsize=16, fontweight='bold')

# Flatten axes for easier iteration
axes_flat = axes.flatten()

# Define colors for consistency
colors = plt.cm.tab10(np.linspace(0, 0.9, 9))

# Get global min/max for consistent axis scaling
min_val = min(df_valid['impedance_data'].min(), df_valid['impedance_data_2'].min())
max_val = max(df_valid['impedance_data'].max(), df_valid['impedance_data_2'].max())

# Plot each electrode in its own subplot
for i, electrode in enumerate(range(1, 10)):
    ax = axes_flat[i]
    df_electrode = df_valid[df_valid['electrode_1'] == electrode]
    
    if len(df_electrode) > 0:
        # Scatter plot
        ax.scatter(df_electrode['impedance_data'], df_electrode['impedance_data_2'], 
                   alpha=0.7, s=50, edgecolors='black', linewidth=0.5, 
                   color=colors[i], label=f'n={len(df_electrode)}')
        
        # Add y=x reference line
        x_line = np.linspace(0, max_val, 100)
        ax.plot(x_line, x_line, 'r--', linewidth=1.5, alpha=0.7)
        
        # Set labels and title
        ax.set_xlabel('Impedance 1 (Ω)', fontsize=10)
        ax.set_ylabel('Impedance 2 (Ω)', fontsize=10)
        ax.set_title(f'Electrode {electrode}', fontsize=12, fontweight='bold')
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=9)
        
        # Set consistent axis limits
        ax.set_xlim(0, max_val * 1.05)
        ax.set_ylim(0, max_val * 1.05)
        ax.set_aspect('equal', adjustable='box')
    else:
        ax.text(0.5, 0.5, f'Electrode {electrode}\nNo Data', 
                ha='center', va='center', fontsize=12, transform=ax.transAxes)
        ax.set_xlabel('Impedance 1 (Ω)', fontsize=10)
        ax.set_ylabel('Impedance 2 (Ω)', fontsize=10)

plt.tight_layout()

# Save the plot
output_filename = latest_file.replace('.csv', '_subplots.png')
plt.savefig(output_filename, dpi=300, bbox_inches='tight')
print(f"Plot saved as: {output_filename}")

plt.show()
