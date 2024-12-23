const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

let selectedFiles = new Set();

// Maximum number of lines to display in the diff to prevent huge rendering
const MAX_DIFF_LINES = 2000;

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
                .trim(); // Final trim
            
            return { indent, content, original: line };
        })
        .filter(line => line.content.length > 0) // Remove empty or whitespace-only lines
        .map(line => line.indent + line.content); // Reconstruct
}

// Function to select anchor points from code
function selectAnchorPoints(lines, count = 10) {
    if (lines.length <= count) return lines.map((line, i) => ({ line, index: i }));
    
    const anchors = [];
    const candidates = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Look for lines that:
        // 1. Have significant content
        // 2. Contain function/class/var keywords
        // 3. Are not comments
        if (
            line.length > 15 &&
            !line.match(/^[\s{}\[\]();]*$/) &&
            !line.match(/^\/\//) &&
            (line.includes('function ') ||
             line.includes('class ') ||
             line.includes(' = ') ||
             line.includes('const ') ||
             line.includes('let '))
        ) {
            candidates.push({ line: lines[i], index: i, score: calculateAnchorScore(line) });
        }
    }
    
    // Sort and pick top candidates, distributing them
    candidates.sort((a, b) => b.score - a.score);
    const totalSections = Math.min(count, candidates.length);
    const sectionSize = Math.floor(lines.length / totalSections);
    
    for (let section = 0; section < totalSections; section++) {
        const sectionStart = section * sectionSize;
        const sectionEnd = sectionStart + sectionSize;
        
        const sectionCandidates = candidates.filter(c => c.index >= sectionStart && c.index < sectionEnd);
        if (sectionCandidates.length > 0) {
            anchors.push(sectionCandidates[0]);
        }
    }
    
    return anchors;
}

function calculateAnchorScore(line) {
    let score = 0;
    score += Math.min(line.length, 50) * 0.5; // longer lines are more unique
    if (line.includes('function ')) score += 30;
    if (line.includes('class ')) score += 30;
    if (line.includes('const ')) score += 20;
    if (line.includes('let ')) score += 15;
    if (line.includes('"') || line.includes("'")) score += 10;
    if (line.match(/\d+/)) score += 5;
    if (line.includes('return ')) score -= 5;
    if (line.includes('break;')) score -= 10;
    if (line.includes('continue;')) score -= 10;
    return score;
}

function findLineOffset(oldLines, newLines) {
    const anchors = selectAnchorPoints(oldLines);
    const offsets = new Map();
    
    for (const anchor of anchors) {
        const anchorLine = anchor.line;
        const oldIndex = anchor.index;
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

// Core diff function that returns an array describing changes
function findMinimalDiff(oldLines, newLines) {
    const diff = [];
    const oldFiltered = oldLines.filter(line => line.trim().length > 0);
    const newFiltered = newLines.filter(line => line.trim().length > 0);
    
    const lineOffset = findLineOffset(oldFiltered, newFiltered);
    
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
        
        const expectedNewIndex = oldIndex + lineOffset;
        if (expectedNewIndex >= 0 && expectedNewIndex < newFiltered.length &&
            oldLine === newFiltered[expectedNewIndex]) {
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
        
        const possibleNewIndices = newLineMap.get(oldLine) || [];
        let bestMatch = -1;
        let bestScore = -1;
        for (const idx of possibleNewIndices) {
            if (Math.abs(idx - (oldIndex + lineOffset)) > 5) continue;
            
            let score = 10 - Math.abs(idx - (oldIndex + lineOffset));
            const contextSize = 2;
            let contextMatches = 0;
            for (let i = 1; i <= contextSize; i++) {
                if (oldIndex - i >= 0 && idx - i >= 0 &&
                    oldFiltered[oldIndex - i] === newFiltered[idx - i]) {
                    contextMatches++;
                }
            }
            for (let i = 1; i <= contextSize; i++) {
                if (oldIndex + i < oldFiltered.length && idx + i < newFiltered.length &&
                    oldFiltered[oldIndex + i] === newFiltered[idx + i]) {
                    contextMatches++;
                }
            }
            
            score += contextMatches * 2;
            if (score > bestScore) {
                bestScore = score;
                bestMatch = idx;
            }
        }
        
        if (bestScore > 0 && bestMatch !== -1) {
            while (newIndex < bestMatch) {
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
        
        if (oldLine !== newLine) {
            diff.push({
                type: 'remove',
                line: oldLine,
                oldNum: oldLineNumber
            });
            oldIndex++;
            oldLineNumber++;
            
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

// Build the diff array (without rendering) so we can render it in chunks
function buildDiffArray(originalContent, newContent) {
    originalContent = originalContent || '';
    newContent = newContent || '';
    
    const originalLines = preprocessCode(originalContent);
    const newLines = preprocessCode(newContent);
    
    const diff = findMinimalDiff(originalLines, newLines);
    return diff;
}

// Render the diff array in chunks to avoid blocking the UI
async function renderDiffInChunks(diff, container) {
    container.innerHTML = ''; // Clear existing
    if (!diff.length) {
        container.innerHTML = '<div class="diff-header">No changes detected</div>';
        return;
    }
    
    const limitedDiff = diff.slice(0, MAX_DIFF_LINES);
    const total = limitedDiff.length;
    const chunkSize = 200; // lines to render in each chunk
    let index = 0;

    // Show truncated notice if total diff lines exceed MAX_DIFF_LINES
    if (diff.length > MAX_DIFF_LINES) {
        container.innerHTML += `<div class="line separator">Diff is too large; only the first ${MAX_DIFF_LINES} lines are displayed.</div>`;
    }

    const diffProgress = document.getElementById('diff-progress');
    const diffProgressBar = document.getElementById('diff-progress-bar');
    if (diffProgress && diffProgressBar) {
        diffProgress.classList.remove('hidden');
        diffProgressBar.style.width = '0%';
    }

    while (index < total) {
        // small delay to let UI update
        await new Promise(resolve => setTimeout(resolve, 10));

        const chunk = limitedDiff.slice(index, index + chunkSize);
        index += chunkSize;

        // Build chunk HTML
        let chunkHtml = '';
        for (let i = 0; i < chunk.length; i++) {
            const current = chunk[i];
            if (current.type === 'remove') {
                chunkHtml += `
                    <div class="line removed">
                        <span class="line-number">-${current.oldNum || ''}</span>
                        <span class="line-content">${escapeHtml(current.line)}</span>
                    </div>`;
            } else if (current.type === 'add') {
                chunkHtml += `
                    <div class="line added">
                        <span class="line-number">+${current.newNum || ''}</span>
                        <span class="line-content">${escapeHtml(current.line)}</span>
                    </div>`;
            } else if (current.type === 'same') {
                chunkHtml += `
                    <div class="line">
                        <span class="line-number">${current.oldNum || ''}</span>
                        <span class="line-content">${escapeHtml(current.line)}</span>
                    </div>`;
            } else {
                // fallback
                chunkHtml += `
                    <div class="line">
                        <span class="line-number"></span>
                        <span class="line-content">${escapeHtml(current.line)}</span>
                    </div>`;
            }
        }

        // Append chunk
        container.innerHTML += chunkHtml;

        // Update progress
        const progress = Math.min(Math.floor((index / total) * 100), 100);
        if (diffProgressBar) {
            diffProgressBar.style.width = `${progress}%`;
        }
    }

    if (diffProgress && diffProgressBar) {
        // Hide after complete
        setTimeout(() => {
            diffProgress.classList.add('hidden');
        }, 600);
    }
}

// Helper function
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Load and display history
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

            if (change.success && change.operation === 'UPDATE' && change.originalContent && change.newContent) {
                changeHtml += `
                    <div class="diff-file-header">${path.basename(change.path)}</div>
                    <div class="diff-content">
                `;
                // Instead of chunking in history, just do a simple single render
                const diffArray = buildDiffArray(change.originalContent, change.newContent);
                if (diffArray.length === 0) {
                    changeHtml += `<div class="diff-header">No changes detected</div>`;
                } else {
                    const limitedDiff = diffArray.slice(0, 100); // short snippet in history
                    if (diffArray.length > 100) {
                        changeHtml += `<div class="line separator">Showing first 100 lines only</div>`;
                    }
                    limitedDiff.forEach(d => {
                        if (d.type === 'remove') {
                            changeHtml += `
                                <div class="line removed">
                                    <span class="line-number">-${d.oldNum || ''}</span>
                                    <span class="line-content">${escapeHtml(d.line)}</span>
                                </div>`;
                        } else if (d.type === 'add') {
                            changeHtml += `
                                <div class="line added">
                                    <span class="line-number">+${d.newNum || ''}</span>
                                    <span class="line-content">${escapeHtml(d.line)}</span>
                                </div>`;
                        } else if (d.type === 'same') {
                            changeHtml += `
                                <div class="line">
                                    <span class="line-number">${d.oldNum || ''}</span>
                                    <span class="line-content">${escapeHtml(d.line)}</span>
                                </div>`;
                        }
                    });
                }
                changeHtml += `</div>`; // close diff-content
            }

            return changeHtml;
        }).join('');

        changes.innerHTML = changesList;

        historyItem.appendChild(timestamp);
        historyItem.appendChild(changes);
        historyList.appendChild(historyItem);
    });
}

document.addEventListener('DOMContentLoaded', () => {
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
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
            const file = e.dataTransfer.files[i];
            if (file.path) {
                filePaths.push(file.path);
            }
        }
    }
    
    if (filePaths.length === 0 && e.dataTransfer.items) {
        for (let i = 0; i < e.dataTransfer.items.length; i++) {
            const item = e.dataTransfer.items[i];
            if (item.getAsFile && item.getAsFile()) {
                const file = item.getAsFile();
                if (file && file.path) {
                    filePaths.push(file.path);
                }
            }
            if (item.type === 'text/plain') {
                item.getAsString((str) => {
                    const potentialPaths = str.split('\n').filter(line =>
                        line.trim().length > 0 &&
                        (line.includes(':\\') || line.startsWith('/'))
                    );
                    potentialPaths.forEach(potentialPath => {
                        try {
                            if (fs.existsSync(potentialPath)) {
                                filePaths.push(potentialPath);
                            }
                        } catch (err) {
                            console.error('Error checking path:', potentialPath, err);
                        }
                    });
                });
            }
            const entry = item.webkitGetAsEntry();
            if (entry && entry.fullPath) {
                filePaths.push(entry.fullPath);
            }
        }
    }
    
    if (filePaths.length === 0) {
        try {
            const text = e.dataTransfer.getData('text');
            if (text) {
                const potentialPaths = text.split('\n').filter(line =>
                    line.trim().length > 0 &&
                    (line.includes(':\\') || line.startsWith('/'))
                );
                
                potentialPaths.forEach(potentialPath => {
                    try {
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

async function displayChanges(xmlContent) {
    const changesList = document.getElementById('changes-list');
    const diffViewer = document.querySelector('.diff-content');
    const diffLoading = document.getElementById('diff-loading');
    const diffToggle = document.getElementById('diff-toggle');
    
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
        const parseError = xmlDoc.querySelector('parsererror');
        if (parseError) {
            changesList.innerHTML = `<div class="change-item">Invalid XML format: ${parseError.textContent}</div>`;
            return;
        }
        
        const codeChanges = xmlDoc.querySelector('code_changes');
        const fileElements = codeChanges 
            ? Array.from(codeChanges.querySelectorAll('changed_files > file'))
            : Array.from(xmlDoc.getElementsByTagName('file'));

        if (fileElements.length === 0) {
            changesList.innerHTML = '<div class="change-item">No changes found in XML</div>';
            return;
        }

        const showDiffForFile = async (fileElement) => {
            if (!diffToggle.checked) {
                diffViewer.innerHTML = '<div class="diff-header">Diff view is disabled</div>';
                return;
            }

            diffLoading.classList.remove('hidden');
            diffViewer.innerHTML = '';

            // short delay to show spinner
            await new Promise(resolve => setTimeout(resolve, 50));

            const operation = fileElement.getElementsByTagName('file_operation')[0]?.textContent || '';
            const filePath = fileElement.getElementsByTagName('file_path')[0]?.textContent || '';
            const fileCode = fileElement.getElementsByTagName('file_code')[0]?.textContent || '';

            try {
                if (operation.toUpperCase() === 'UPDATE') {
                    if (fs.existsSync(filePath)) {
                        const originalContent = fs.readFileSync(filePath, 'utf-8');
                        const diffArray = buildDiffArray(originalContent, fileCode);
                        await renderDiffInChunks(diffArray, diffViewer);
                    } else {
                        diffViewer.innerHTML = '<div class="diff-header">Original file not found</div>';
                    }
                } else if (operation.toUpperCase() === 'CREATE') {
                    const diffArray = buildDiffArray('', fileCode);
                    diffViewer.innerHTML = `<div class="diff-header">New File</div>`;
                    await renderDiffInChunks(diffArray, diffViewer);
                } else if (operation.toUpperCase() === 'DELETE') {
                    if (fs.existsSync(filePath)) {
                        const content = fs.readFileSync(filePath, 'utf-8');
                        const diffArray = buildDiffArray(content, '');
                        diffViewer.innerHTML = `<div class="diff-header">File to be deleted</div>`;
                        await renderDiffInChunks(diffArray, diffViewer);
                    } else {
                        diffViewer.innerHTML = '<div class="diff-header">File already deleted or not found</div>';
                    }
                }
            } catch (error) {
                console.error('Error generating diff:', error);
                diffViewer.innerHTML = `<div class="diff-header">Error: ${error.message}</div>`;
            } finally {
                diffLoading.classList.add('hidden');
            }
        };

        const updateSelectedState = (selectedItem) => {
            document.querySelectorAll('.change-item').forEach(item => {
                item.classList.remove('selected');
            });
            selectedItem.classList.add('selected');
        };

        let firstChangeItem = null;
        if (fileElements.length > 0) {
            await showDiffForFile(fileElements[0]);
        }

        for (const fileElement of fileElements) {
            const summary = fileElement.getElementsByTagName('file_summary')[0]?.textContent || '';
            const operation = fileElement.getElementsByTagName('file_operation')[0]?.textContent || '';
            const filePath = fileElement.getElementsByTagName('file_path')[0]?.textContent || '';

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
            
            if (!firstChangeItem) {
                firstChangeItem = changeItem;
                changeItem.classList.add('selected');
            }

            // small delay between file items
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        diffToggle.addEventListener('change', () => {
            if (firstChangeItem) {
                showDiffForFile(fileElements[0]);
            }
        });
    } catch (error) {
        changesList.innerHTML = `<div class="change-item">Error parsing XML: ${error.message}</div>`;
    }
}

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
            document.getElementById('xml-input').value = '';
            document.getElementById('changes-list').innerHTML = '';
            document.querySelector('.diff-content').innerHTML = '';
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
