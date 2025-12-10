import pandas as pd
import matplotlib.pyplot as plt
import glob
import os

# Get all CSV files in the current directory
csv_files = sorted(glob.glob('mms_impedance_*.csv'))

if not csv_files:
    print("No impedance CSV files found!")
    exit()

# Read and combine all CSV files
all_data = []
for file in csv_files:
    df = pd.read_csv(file)
    df['source_file'] = os.path.basename(file)
    all_data.append(df)

data = pd.concat(all_data, ignore_index=True)

# Filter for measurement indices 72 onwards
data = data[data['measurement_index'] >= 72].copy()

# Filter out 9999999 values
data_filtered = data[data['impedance_data'] != 9999999].copy()

print(f"Total measurements (index >= 72): {len(data)}")
print(f"Valid measurements (excluding 9999999): {len(data_filtered)}")
print(f"\nImpedance range: {data_filtered['impedance_data'].min()} - {data_filtered['impedance_data'].max()}")

# Extract pair information for grouping
data_filtered['pair'] = data_filtered['pair'].astype(str)

# Get unique files and assign colors
files = sorted(data_filtered['source_file'].unique())
print(f"\nFiles in dataset:")
colors_map = {files[0]: 'blue', files[1]: 'orange'} if len(files) == 2 else {files[i]: plt.cm.tab10(i) for i in range(len(files))}

for i, file in enumerate(files):
    file_count = len(data_filtered[data_filtered['source_file'] == file])
    print(f"  File {i+1}: {file_count} valid measurements")

# Create the plot with pairs on x-axis
fig, ax = plt.subplots(figsize=(14, 8))

# Get unique pairs and create numeric positions
pairs_sorted = sorted(data_filtered['pair'].unique(), key=lambda x: tuple(map(int, x.split(','))))
pair_to_pos = {pair: i for i, pair in enumerate(pairs_sorted)}

# Plot by file
for i, file in enumerate(files):
    file_data = data_filtered[data_filtered['source_file'] == file]
    x_positions = [pair_to_pos[pair] for pair in file_data['pair']]
    
    color = colors_map[file]
    label = f'File {i+1}'
    ax.scatter(x_positions, file_data['impedance_data'],
               label=label, alpha=0.7, s=60, color=color)

ax.set_xlabel('Electrode Pair', fontsize=13)
ax.set_ylabel('Impedance (Ohm)', fontsize=13)
ax.set_title('Impedance by Electrode Pair (Index >= 72)', fontsize=15, fontweight='bold')
ax.set_xticks(range(len(pairs_sorted)))
ax.set_xticklabels(pairs_sorted, rotation=45, ha='right')
ax.grid(True, alpha=0.3)
ax.legend(fontsize=11)

plt.tight_layout()
plt.savefig('impedance_plot.png', dpi=300, bbox_inches='tight')
print("\nPlot saved as 'impedance_plot.png'")
plt.show()

# Print summary
print("\n" + "="*70)
print("SUMMARY")
print("="*70)
for i, file in enumerate(files):
    file_data = data_filtered[data_filtered['source_file'] == file]
    print(f"\nFile {i+1}: {len(file_data)} measurements")
    print(f"  Mean: {file_data['impedance_data'].mean():.1f} Ohm")
    print(f"  Std: {file_data['impedance_data'].std():.1f} Ohm")
    print(f"  Range: {file_data['impedance_data'].min():.1f} - {file_data['impedance_data'].max():.1f} Ohm")
