const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

let selectedFiles = new Set();

// Format timestamp to a readable format
function formatTimestamp(isoString) {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

// Function to preprocess code for comparison
function preprocessCode(code) {
    // Split into lines, filter out empty lines, and normalize each line
    return code.split('\n')
        .map(line => {
            // Preserve indentation for non-empty lines
            const indent = line.match(/^\s*/)[0];
            // Normalize the actual content
            const content = line.trim()
                // Remove all whitespace first
                .replace(/\s+/g, ' ')
                // Then add normalized spacing for common patterns
                .replace(/([,;=:\{\}\(\)\[\]])/g, ' $1 ')
                // Clean up any double spaces created
                .replace(/\s+/g, ' ')
                // Finally normalize specific patterns
                .replace(/\s*,\s*/g, ', ')
                .replace(/\s*;\s*/g, ';')
                .replace(/\s*=\s*/g, ' = ')
                .replace(/\s*:\s*/g, ': ')
                .replace(/\s*\{\s*/g, ' {')
                .replace(/\s*\}\s*/g, '}')
                .replace(/\s*\(\s*/g, '(')
                .replace(/\s*\)\s*/g, ')')
                .replace(/\s*\[\s*/g, '[')
                .replace(/\s*\]\s*/g, ']')
                .trim(); // Final trim to ensure no leading/trailing space
            
            return { indent, content, original: line };
        })
        .filter(line => line.content.length > 0) // Remove empty or whitespace-only lines
        .map(line => line.indent + line.content); // Reconstruct the line with indentation
}

// Function to select anchor points from code
function selectAnchorPoints(lines, count = 10) {
    if (lines.length <= count) return lines.map((line, i) => ({ line, index: i }));
    
    const anchors = [];
    const step = Math.floor(lines.length / count);
    
    // First pass: Find unique, complex lines that make good anchors
    const candidates = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Look for lines that:
        // 1. Have significant content (not just brackets/semicolons)
        // 2. Contain function definitions, class declarations, or unique variable assignments
        // 3. Are not comments
        if (line && 
            line.length > 15 && // Longer lines tend to be more unique
            !line.match(/^[\s{}\[\]();]*$/) && // Skip simple structural lines
            !line.match(/^\/\//) && // Skip comments
            (line.includes('function ') || // Function definitions
             line.includes('class ') || // Class declarations
             line.includes(' = ') || // Variable assignments
             line.includes('const ') || // Constant declarations
             line.includes('let '))) { // Variable declarations
            candidates.push({ line: lines[i], index: i, score: calculateAnchorScore(line) });
        }
    }
    
    // Sort candidates by score (higher is better)
    candidates.sort((a, b) => b.score - a.score);
    
    // Select evenly distributed anchors from top candidates
    const totalSections = Math.min(count, candidates.length);
    const sectionSize = Math.floor(lines.length / totalSections);
    
    for (let section = 0; section < totalSections; section++) {
        const sectionStart = section * sectionSize;
        const sectionEnd = sectionStart + sectionSize;
        
        // Find the best candidate in this section
        const sectionCandidates = candidates.filter(c => 
            c.index >= sectionStart && c.index < sectionEnd
        );
        
        if (sectionCandidates.length > 0) {
            anchors.push(sectionCandidates[0]);
        }
    }
    
    return anchors;
}

// Calculate how good a line would be as an anchor
function calculateAnchorScore(line) {
    let score = 0;
    
    // Longer lines are usually more unique
    score += Math.min(line.length, 50) * 0.5;
    
    // Function definitions are very stable
    if (line.includes('function ')) score += 30;
    
    // Class declarations are very stable
    if (line.includes('class ')) score += 30;
    
    // Variable declarations are moderately stable
    if (line.includes('const ')) score += 20;
    if (line.includes('let ')) score += 15;
    
    // Lines with string literals are somewhat unique
    if (line.includes('"') || line.includes("'")) score += 10;
    
    // Lines with numbers are somewhat unique
    if (line.match(/\d+/)) score += 5;
    
    // Penalize very common patterns
    if (line.includes('return ')) score -= 5;
    if (line.includes('break;')) score -= 10;
    if (line.includes('continue;')) score -= 10;
    
    return score;
}

// Function to find line offset using anchor points
function findLineOffset(oldLines, newLines) {
    const anchors = selectAnchorPoints(oldLines);
    const offsets = new Map();
    
    for (const anchor of anchors) {
        const anchorLine = anchor.line;
        const oldIndex = anchor.index;
        
        // Search for this anchor in new lines within a reasonable range
        const searchStart = Math.max(0, oldIndex - 50);
        const searchEnd = Math.min(newLines.length, oldIndex + 50);
        
        for (let i = searchStart; i < searchEnd; i++) {
            if (newLines[i] === anchorLine) {
                const offset = i - oldIndex;
                offsets.set(offset, (offsets.get(offset) || 0) + 1);
                break;
            }
        }
    }
    
    // Find most common offset
    let maxCount = 0;
    let mostCommonOffset = 0;
    for (const [offset, count] of offsets) {
        if (count > maxCount) {
            maxCount = count;
            mostCommonOffset = offset;
        }
    }
    
    return mostCommonOffset;
}

// Function to find minimal diff between two arrays of lines
function findMinimalDiff(oldLines, newLines) {
    const diff = [];
    
    // Filter out empty lines and create line number mapping
    const oldFiltered = oldLines.filter(line => line.trim().length > 0);
    const newFiltered = newLines.filter(line => line.trim().length > 0);
    
    // Calculate line offset using filtered lines
    const lineOffset = findLineOffset(oldFiltered, newFiltered);
    
    // Create a map of line content to indices for quick lookup
    const newLineMap = new Map();
    newFiltered.forEach((line, index) => {
        if (!newLineMap.has(line)) {
            newLineMap.set(line, []);
        }
        newLineMap.get(line).push(index);
    });
    
    let oldIndex = 0;
    let newIndex = 0;
    let oldLineNumber = 1;
    let newLineNumber = 1;
    
    while (oldIndex < oldFiltered.length || newIndex < newFiltered.length) {
        // Handle case where we've reached the end of one array
        if (oldIndex >= oldFiltered.length) {
            while (newIndex < newFiltered.length) {
                if (newFiltered[newIndex].trim().length > 0) {
                    diff.push({
                        type: 'add',
                        line: newFiltered[newIndex],
                        newNum: newLineNumber
                    });
                }
                newIndex++;
                newLineNumber++;
            }
            break;
        }
        if (newIndex >= newFiltered.length) {
            while (oldIndex < oldFiltered.length) {
                if (oldFiltered[oldIndex].trim().length > 0) {
                    diff.push({
                        type: 'remove',
                        line: oldFiltered[oldIndex],
                        oldNum: oldLineNumber
                    });
                }
                oldIndex++;
                oldLineNumber++;
            }
            break;
        }
        
        const oldLine = oldFiltered[oldIndex];
        const newLine = newFiltered[newIndex];
        
        // Skip empty lines
        if (oldLine.trim().length === 0) {
            oldIndex++;
            oldLineNumber++;
            continue;
        }
        if (newLine.trim().length === 0) {
            newIndex++;
            newLineNumber++;
            continue;
        }

        // Check for exact match considering line offset
        const expectedNewIndex = oldIndex + lineOffset;
        if (expectedNewIndex >= 0 && expectedNewIndex < newFiltered.length && 
            oldLine === newFiltered[expectedNewIndex]) {
            // Lines match at the expected offset
            while (newIndex < expectedNewIndex) {
                if (newFiltered[newIndex].trim().length > 0) {
                    diff.push({
                        type: 'add',
                        line: newFiltered[newIndex],
                        newNum: newLineNumber
                    });
                }
                newIndex++;
                newLineNumber++;
            }
            diff.push({
                type: 'same',
                line: oldLine,
                oldNum: oldLineNumber,
                newNum: newLineNumber
            });
            oldIndex++;
            oldLineNumber++;
            newIndex++;
            newLineNumber++;
            continue;
        }
        
        // Look for the current old line in nearby positions of new file
        const possibleNewIndices = newLineMap.get(oldLine) || [];
        
        // Find the best matching position by considering:
        // 1. Distance from expected position (weighted most heavily)
        // 2. Surrounding context similarity
        let bestMatch = -1;
        let bestScore = -1;
        
        for (const idx of possibleNewIndices) {
            if (Math.abs(idx - (oldIndex + lineOffset)) > 5) continue; // Skip if too far
            
            let score = 10 - Math.abs(idx - (oldIndex + lineOffset)); // Distance score
            
            // Check surrounding lines for context
            const contextSize = 2;
            let contextMatches = 0;
            
            // Look at lines before the match
            for (let i = 1; i <= contextSize; i++) {
                if (oldIndex - i >= 0 && idx - i >= 0 && 
                    oldFiltered[oldIndex - i] === newFiltered[idx - i]) {
                    contextMatches++;
                }
            }
            
            // Look at lines after the match
            for (let i = 1; i <= contextSize; i++) {
                if (oldIndex + i < oldFiltered.length && idx + i < newFiltered.length && 
                    oldFiltered[oldIndex + i] === newFiltered[idx + i]) {
                    contextMatches++;
                }
            }
            
            score += contextMatches * 2; // Context matching bonus
            
            if (score > bestScore) {
                bestScore = score;
                bestMatch = idx;
            }
        }
        
        const nearbyMatch = bestScore > 0 ? bestMatch : undefined;
        
        if (nearbyMatch !== undefined) {
            // Found a match nearby - add any new lines before it
            while (newIndex < nearbyMatch) {
                if (newFiltered[newIndex].trim().length > 0) {
                    diff.push({
                        type: 'add',
                        line: newFiltered[newIndex],
                        newNum: newLineNumber
                    });
                }
                newIndex++;
                newLineNumber++;
            }
            diff.push({
                type: 'same',
                line: oldLine,
                oldNum: oldLineNumber,
                newNum: newLineNumber
            });
            oldIndex++;
            oldLineNumber++;
            newIndex++;
            newLineNumber++;
            continue;
        }
        
        // No match found - handle as a change
        if (oldLine !== newLine) {
            diff.push({
                type: 'remove',
                line: oldLine,
                oldNum: oldLineNumber
            });
            oldIndex++;
            oldLineNumber++;
            
            // Only add the new line if it's not found later near its expected position
            const futureMatch = possibleNewIndices.find(idx => 
                idx > newIndex && Math.abs(idx - (oldIndex + lineOffset)) < 3
            );
            if (!futureMatch) {
                diff.push({
                    type: 'add',
                    line: newLine,
                    newNum: newLineNumber
                });
                newIndex++;
                newLineNumber++;
            }
        }
    }
    
    return diff;
}

// Function to create a diff view for text content
function createDiffView(originalContent, newContent) {
    if (!originalContent && !newContent) return '<div class="diff-header">No content to compare</div>';
    
    // Initialize empty content as empty string
    originalContent = originalContent || '';
    newContent = newContent || '';

    const originalLines = preprocessCode(originalContent);
    const newLines = preprocessCode(newContent);
    
    // Get the diff using minimal diff algorithm
    const diff = findMinimalDiff(originalLines, newLines);
    
    let diffHtml = '<div class="diff-content">';
    let changes = false;
    let contextLines = 3; // Number of unchanged lines to show around changes
    let lastPrintedLine = -1;
    
    for (let i = 0; i < diff.length; i++) {
        const current = diff[i];
        
        // Determine if we should show this line based on proximity to changes
        const nearbyChange = diff.slice(Math.max(0, i - contextLines), Math.min(diff.length, i + contextLines + 1))
            .some(d => d.type === 'add' || d.type === 'remove');
        
        if (current.type !== 'same' || nearbyChange) {
            // Add separator if we skipped lines
            if (lastPrintedLine !== -1 && i > lastPrintedLine + 1) {
                diffHtml += '<div class="line separator">...</div>';
            }
            
            if (current.type === 'remove') {
                changes = true;
                diffHtml += `
                    <div class="line removed">
                        <span class="line-number">-${current.oldNum}</span>
                        <span class="line-content">${escapeHtml(current.line)}</span>
                    </div>`;
            } else if (current.type === 'add') {
                changes = true;
                diffHtml += `
                    <div class="line added">
                        <span class="line-number">+${current.newNum}</span>
                        <span class="line-content">${escapeHtml(current.line)}</span>
                    </div>`;
            } else {
                diffHtml += `
                    <div class="line">
                        <span class="line-number">${current.oldNum}</span>
                        <span class="line-content">${escapeHtml(current.line)}</span>
                    </div>`;
            }
            lastPrintedLine = i;
        }
    }
    
    diffHtml += '</div>';
    return changes ? diffHtml : '<div class="diff-content"><div class="diff-header">No changes detected</div></div>';
}

// Helper function to escape HTML special characters
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Load and display history with diff view
async function loadHistory() {
    const history = await ipcRenderer.invoke('get-history');
    const historyList = document.getElementById('history-list');
    historyList.innerHTML = '';

    if (history.length === 0) {
        historyList.innerHTML = '<div class="history-item">No changes yet</div>';
        return;
    }

    history.forEach(entry => {
        const historyItem = document.createElement('div');
        historyItem.className = 'history-item';

        const timestamp = document.createElement('div');
        timestamp.className = 'timestamp';
        timestamp.textContent = formatTimestamp(entry.timestamp);

        const changes = document.createElement('div');
        changes.className = 'changes';
        
        const changesList = entry.changes.map(change => {
            const status = change.success ? '✓' : '✗';
            const statusColor = change.success ? 'color: #34c759;' : 'color: #ff3b30;';
            let changeHtml = `<div style="${statusColor}">
                ${status} ${change.operation}: ${change.path}
                ${change.error ? `<div style="color: #ff3b30; margin-left: 20px;">${change.error}</div>` : ''}
            </div>`;

            // Add diff view for updates
            if (change.success && change.operation === 'UPDATE' && change.originalContent && change.newContent) {
                changeHtml += `
                    <div class="diff-file-header">${path.basename(change.path)}</div>
                    ${createDiffView(change.originalContent, change.newContent)}
                `;
            }

            return changeHtml;
        }).join('');

        changes.innerHTML = changesList;

        historyItem.appendChild(timestamp);
        historyItem.appendChild(changes);
        historyList.appendChild(historyItem);
    });
}

// Load history when the app starts - wait for DOM to be ready
document.addEventListener('DOMContentLoaded', () => {
    // Load version and author info from package.json
    const packageInfo = require('./package.json');
    document.getElementById('version').textContent = `v${packageInfo.version}`;

    loadHistory().catch(err => {
        console.error('Error loading history:', err);
    });
});

document.getElementById('select-files').addEventListener('click', async () => {
    const filePaths = await ipcRenderer.invoke('select-files');
    addFilesToList(filePaths);
});

document.getElementById('drop-area').addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    document.getElementById('drop-area').classList.add('drag-over');
});

document.getElementById('drop-area').addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('drop-area').classList.remove('drag-over');
});

document.getElementById('drop-area').addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('drop-area').classList.remove('drag-over');
    
    const filePaths = [];
    
    // Method 1: Try to extract paths from different sources
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
            const file = e.dataTransfer.files[i];
            if (file.path) {
                filePaths.push(file.path);
            }
        }
    }
    
    // Method 2: Try to extract paths from items
    if (filePaths.length === 0 && e.dataTransfer.items) {
        for (let i = 0; i < e.dataTransfer.items.length; i++) {
            const item = e.dataTransfer.items[i];
            
            // Try different methods to get file path
            if (item.getAsFile && item.getAsFile()) {
                const file = item.getAsFile();
                if (file && file.path) {
                    filePaths.push(file.path);
                }
            }
            
            // VSCode specific: try to get path from string representation
            if (item.type === 'text/plain') {
                item.getAsString((str) => {
                    // Try to extract file path from string
                    const potentialPaths = str.split('\n').filter(line => {
                        // Basic path validation
                        return line.trim().length > 0 && 
                               (line.includes(':\\') || line.startsWith('/'));
                    });
                    
                    potentialPaths.forEach(potentialPath => {
                        try {
                            // Verify the path exists
                            if (fs.existsSync(potentialPath)) {
                                filePaths.push(potentialPath);
                            }
                        } catch (err) {
                            console.error('Error checking path:', potentialPath, err);
                        }
                    });
                });
            }
            
            // Fallback to webkitGetAsEntry
            const entry = item.webkitGetAsEntry();
            if (entry && entry.fullPath) {
                filePaths.push(entry.fullPath);
            }
        }
    }
    
    // Method 3: Last resort - try to parse dataTransfer text
    if (filePaths.length === 0) {
        try {
            const text = e.dataTransfer.getData('text');
            if (text) {
                const potentialPaths = text.split('\n').filter(line => {
                    // Basic path validation
                    return line.trim().length > 0 && 
                           (line.includes(':\\') || line.startsWith('/'));
                });
                
                potentialPaths.forEach(potentialPath => {
                    try {
                        // Verify the path exists
                        if (fs.existsSync(potentialPath)) {
                            filePaths.push(potentialPath);
                        }
                    } catch (err) {
                        console.error('Error checking path:', potentialPath, err);
                    }
                });
            }
        } catch (err) {
            console.error('Error parsing drag transfer text', err);
        }
    }
    
    // Remove duplicates and add to list
    const uniqueFilePaths = [...new Set(filePaths)];
    addFilesToList(uniqueFilePaths);
});

document.getElementById('fileInput').addEventListener('change', (e) => {
    const files = e.target.files;
    const filePaths = Array.from(files).map(file => file.path);
    addFilesToList(filePaths);
});

document.getElementById('generate-xml').addEventListener('click', async () => {
    if (selectedFiles.size === 0) {
        alert('Please select files or folders first');
        return;
    }
    
    const requestText = document.getElementById('request-input').value;
    
    const xmlContent = await ipcRenderer.invoke('generate-xml', {
        filePaths: Array.from(selectedFiles),
        request: requestText
    });
    alert('XML has been copied to clipboard!');
});

// Function to parse XML and display changes with diff preview
function displayChanges(xmlContent) {
    const changesList = document.getElementById('changes-list');
    const diffViewer = document.querySelector('.diff-content');
    
    // Clear previous content
    changesList.innerHTML = '';
    if (diffViewer) {
        diffViewer.innerHTML = '';
    }

    if (!xmlContent.trim()) {
        changesList.innerHTML = '<div class="change-item">No XML content provided</div>';
        return;
    }

    try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlContent, 'text/xml');
        
        // Check for XML parsing errors
        const parseError = xmlDoc.querySelector('parsererror');
        if (parseError) {
            changesList.innerHTML = `<div class="change-item">Invalid XML format: ${parseError.textContent}</div>`;
            return;
        }
        
        // First try to get files from code_changes structure
        const codeChanges = xmlDoc.querySelector('code_changes');
        const fileElements = codeChanges ? 
            Array.from(codeChanges.querySelectorAll('changed_files > file')) :
            Array.from(xmlDoc.getElementsByTagName('file'));

        if (fileElements.length === 0) {
            changesList.innerHTML = '<div class="change-item">No changes found in XML</div>';
            return;
        }

        // Function to show diff for a file
        const showDiffForFile = (fileElement) => {
            const diffContent = document.querySelector('.diff-content');
            if (!diffContent) return;

            const operation = fileElement.getElementsByTagName('file_operation')[0]?.textContent || '';
            const filePath = fileElement.getElementsByTagName('file_path')[0]?.textContent || '';
            const fileCode = fileElement.getElementsByTagName('file_code')[0]?.textContent || '';

            if (operation.toUpperCase() === 'UPDATE') {
                try {
                    if (fs.existsSync(filePath)) {
                        const originalContent = fs.readFileSync(filePath, 'utf-8');
                        diffContent.innerHTML = createDiffView(originalContent, fileCode);
                    } else {
                        diffContent.innerHTML = '<div class="diff-header">Original file not found</div>';
                    }
                } catch (error) {
                    console.error('Error reading file for diff:', error);
                    diffContent.innerHTML = `<div class="diff-header">Error: ${error.message}</div>`;
                }
            } else if (operation.toUpperCase() === 'CREATE') {
                diffContent.innerHTML = `<div class="diff-header">New File</div>${createDiffView('', fileCode)}`;
            } else if (operation.toUpperCase() === 'DELETE') {
                try {
                    if (fs.existsSync(filePath)) {
                        const content = fs.readFileSync(filePath, 'utf-8');
                        diffContent.innerHTML = `<div class="diff-header">File to be deleted</div>${createDiffView(content, '')}`;
                    } else {
                        diffContent.innerHTML = '<div class="diff-header">File already deleted</div>';
                    }
                } catch (error) {
                    console.error('Error reading file for deletion preview:', error);
                    diffContent.innerHTML = `<div class="diff-header">Error: ${error.message}</div>`;
                }
            }
        };

        // Function to update selected state
        const updateSelectedState = (selectedItem) => {
            // Remove selected class from all items
            document.querySelectorAll('.change-item').forEach(item => {
                item.classList.remove('selected');
            });
            // Add selected class to clicked item
            selectedItem.classList.add('selected');
        };

        let firstChangeItem = null;

        // Show first file's changes by default
        if (fileElements.length > 0) {
            showDiffForFile(fileElements[0]);
        }

        for (const fileElement of fileElements) {
            const summary = fileElement.getElementsByTagName('file_summary')[0]?.textContent || '';
            const operation = fileElement.getElementsByTagName('file_operation')[0]?.textContent || '';
            const filePath = fileElement.getElementsByTagName('file_path')[0]?.textContent || '';
            const fileCode = fileElement.getElementsByTagName('file_code')[0]?.textContent || '';

            const changeItem = document.createElement('div');
            changeItem.className = `change-item ${operation.toLowerCase()}`;
            changeItem.onclick = () => {
                showDiffForFile(fileElement);
                updateSelectedState(changeItem);
            };

            const operationSpan = document.createElement('span');
            operationSpan.className = 'operation';
            operationSpan.textContent = operation;
            
            const pathDiv = document.createElement('div');
            pathDiv.className = 'path';
            pathDiv.textContent = filePath;

            const summaryDiv = document.createElement('div');
            summaryDiv.className = 'summary';
            summaryDiv.textContent = summary;

            changeItem.appendChild(operationSpan);
            changeItem.appendChild(pathDiv);
            changeItem.appendChild(summaryDiv);
            
            changesList.appendChild(changeItem);
            
            // Store reference to first item
            if (!firstChangeItem) {
                firstChangeItem = changeItem;
                changeItem.classList.add('selected');
            }
        }
    } catch (error) {
        changesList.innerHTML = `<div class="change-item">Error parsing XML: ${error.message}</div>`;
    }
}

// Update changes list when XML content changes
document.getElementById('xml-input').addEventListener('input', (e) => {
    const xmlContent = e.target.value.trim();
    if (xmlContent) {
        displayChanges(xmlContent);
    } else {
        document.getElementById('changes-list').innerHTML = '';
        const diffViewer = document.querySelector('.diff-content');
        if (diffViewer) diffViewer.innerHTML = '';
    }
});

document.getElementById('apply-xml').addEventListener('click', async () => {
    const xmlContent = document.getElementById('xml-input').value.trim();
    
    if (!xmlContent) {
        alert('Please paste XML code to apply');
        return;
    }
    
    try {
        const result = await ipcRenderer.invoke('apply-xml', xmlContent);
        if (result.success) {
            // Clear the input and changes list after successful application
            document.getElementById('xml-input').value = '';
            document.getElementById('changes-list').innerHTML = '';
            document.querySelector('.diff-content').innerHTML = '';
            
            // Reload history to show new changes
            await loadHistory();
            
            alert('Successfully applied XML changes!');
        } else {
            alert(`Failed to apply XML changes: ${result.error}`);
        }
    } catch (error) {
        alert(`Error applying XML changes: ${error.message}`);
    }
});

function addFilesToList(filePaths) {
    filePaths.forEach(filePath => {
        // Normalize the path to handle different path formats
        const normalizedPath = path.normalize(filePath);
        
        if (!selectedFiles.has(normalizedPath)) {
            selectedFiles.add(normalizedPath);
            createFileListItem(normalizedPath);
        }
    });
}

function createFileListItem(filePath) {
    const fileListElement = document.getElementById('file-list');
    const fileItem = document.createElement('div');
    fileItem.classList.add('file-item');
    
    const filePathSpan = document.createElement('span');
    filePathSpan.textContent = filePath;
    fileItem.appendChild(filePathSpan);
    
    const removeButton = document.createElement('button');
    removeButton.textContent = '✖';
    removeButton.classList.add('remove-file');
    removeButton.addEventListener('click', () => {
        selectedFiles.delete(filePath);
        fileListElement.removeChild(fileItem);
    });
    fileItem.appendChild(removeButton);
    
    fileListElement.appendChild(fileItem);
}
