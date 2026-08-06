## ADDED Requirements

### Requirement: Public specification pages SHALL load document bodies without eagerly compiling the full corpus

The public-site deployable SHALL retain specification metadata needed for navigation and route generation without requiring every specification document body to compile before a requested page can render. The selected document body and its table of contents SHALL load together from the same generated source entry.

#### Scenario: A reviewer opens a specification page

- **WHEN** a reviewer visits `/specification` or a nested specification route
- **THEN** the public-site deployable SHALL load and render the selected document body
- **AND** the rendered table of contents SHALL describe that same selected document
- **AND** unrelated specification document bodies SHALL NOT need to compile before the selected page can render

#### Scenario: The site generates specification navigation

- **WHEN** the public-site deployable builds route metadata or the specification page tree
- **THEN** it SHALL be able to read the document metadata without loading every document body
