# DropoutGuard – AI Early Warning & Intervention System

> **Identify Early. Intervene Early. Prevent Dropout.**

DropoutGuard is a hackathon project designed to identify students who may be at risk of dropping out **2–3 months in advance**. It uses data already available in a school's Management Information System (MIS), such as attendance, academic performance, absence patterns, and relevant local/context factors.

Instead of reacting to a single attendance drop, DropoutGuard looks at **patterns and trends** and provides an explainable **“WHY + WHAT NEXT?”** intervention layer for teachers.

## Problem Statement

Government schools may identify a student as having effectively dropped out only after months of unexplained absence. By then, intervention can become difficult.

A short attendance decline may be temporary. Therefore, an effective early-warning system should consider trends and context rather than treating every attendance drop as a dropout.

## Our Solution

```text
School MIS Data
      ↓
Attendance + Marks + Absence Patterns + Local Factors
      ↓
Data Processing & Trend Analysis
      ↓
Machine Learning Model
      ↓
Dropout Risk Score
      ↓
WHY? — Explain the risk
      ↓
WHAT NEXT? — Recommend an intervention
      ↓
Teacher Dashboard
      ↓
Intervention Tracking
```

**Goal:** Move from **Late Detection → Early Identification → Timely Intervention**

## Key Features

### 1. Smart Dropout Risk Score
Students are categorized as:
- Low Risk
- Medium Risk
- High Risk

### 2. Context-Aware Prediction
The system considers:
- Attendance trends
- Academic performance trends
- Repeated/consecutive absences
- Relevant local/context factors

### 3. “WHY + WHAT NEXT?” Intervention Engine

**WHY?**
- Attendance has been continuously declining.
- Academic performance is declining.
- Repeated absences have been detected.

**WHAT NEXT?**
- Contact the parent/guardian.
- Talk to the student.
- Provide academic support.
- Monitor attendance.
- Schedule a follow-up.

### 4. Intervention Tracking
Teachers can record actions taken and monitor student progress.

### 5. Role-Based Dashboards

**Teacher/Admin**
- Upload MIS data
- View risk distribution
- Identify high-risk students
- View WHY + WHAT NEXT?
- Record interventions
- Monitor progress

**Student**
- View attendance and performance
- View risk status
- View recommendations
- Request academic support

**Parent/Guardian**
- View child's attendance and performance
- Understand risk reasons
- View recommended actions
- Contact/request a meeting with the teacher
- Track intervention progress

## Machine Learning Approach

The MVP uses a practical machine-learning approach:

- **Python**
- **Pandas**
- **NumPy**
- **Scikit-learn**
- **Random Forest Classifier**

For the prototype, model prediction can be combined with simple rule-based explanations.

Example:

```python
if attendance_trend == "falling":
    reasons.append("Attendance has been continuously declining")

if marks_trend == "falling":
    reasons.append("Academic performance is declining")

if consecutive_absences >= 5:
    reasons.append("Repeated consecutive absences")
```

## Input Data

For the hackathon prototype, a teacher/admin can upload an Excel or CSV file exported from the school's MIS.

Example columns:

| Column | Description |
|---|---|
| Student_ID | Unique student identifier |
| Name | Student name |
| Class | Student's class/grade |
| Attendance | Attendance percentage |
| Marks | Academic performance |
| Absence_Count | Number of absences |
| Local_Factor | Relevant contextual factor |

Example:

```text
Student_ID,Name,Class,Attendance,Marks,Absence_Count,Local_Factor
ST001,Rahul Sharma,9,52,46,12,Family issue
ST002,Priya Patil,9,91,84,2,None
```

> Use anonymized/sample data for demonstrations. Do not upload real student personal data to GitHub.

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, JavaScript |
| Charts | Chart.js |
| Backend | Python, Flask |
| Data Processing | Pandas, NumPy |
| Machine Learning | Scikit-learn |
| Database | MySQL |
| Version Control | Git & GitHub |

## Suggested Project Structure

```text
DropoutGuard/
│
├── app.py
├── requirements.txt
├── README.md
├── .gitignore
│
├── data/
│   └── sample_students.csv
│
├── model/
│   └── dropout_model.pkl
│
├── templates/
│   ├── index.html
│   ├── login.html
│   ├── signup.html
│   ├── teacher_dashboard.html
│   ├── student_dashboard.html
│   ├── parent_dashboard.html
│   ├── student_risk.html
│   └── intervention.html
│
├── static/
│   ├── css/
│   │   └── style.css
│   └── js/
│       └── script.js
│
└── ml/
    ├── preprocessing.py
    ├── train_model.py
    └── prediction.py
```

> Adjust the structure to match the actual files in the repository.

## How to Run

### 1. Clone the repository

```bash
git clone https://github.com/YOUR-USERNAME/DropoutGuard.git
cd DropoutGuard
```

### 2. Create a virtual environment

```bash
python -m venv venv
```

### 3. Activate it

**Windows:**
```bash
venv\Scripts\activate
```

**macOS/Linux:**
```bash
source venv/bin/activate
```

### 4. Install dependencies

```bash
pip install -r requirements.txt
```

### 5. Configure environment variables

Create a `.env` file for sensitive settings such as:

```text
SECRET_KEY=your_secret_key
DB_HOST=localhost
DB_USER=your_database_user
DB_PASSWORD=your_database_password
DB_NAME=dropoutguard
```

**Never upload `.env` to GitHub.**

Add this to `.gitignore`:

```text
.env
venv/
__pycache__/
*.pyc
```

### 6. Start the application

```bash
python app.py
```

Open:

```text
http://127.0.0.1:5000
```

## Example User Flow

```text
Teacher Login
      ↓
Teacher Dashboard
      ↓
Upload Excel/CSV
      ↓
Validate & Process Data
      ↓
AI Risk Prediction
      ↓
Risk Distribution
      ↓
Student Risk Details
      ↓
WHY?
      ↓
WHAT NEXT?
      ↓
Record Intervention
      ↓
Monitor Progress
```

## Example Risk Analysis

**Student:** Rahul Sharma  
**Class:** 9  
**Attendance:** 52%  
**Marks:** 46%  
**Absence Count:** 12  
**Risk Score:** 84%  
**Risk Level:** High

**WHY?**
- Attendance has been continuously declining.
- Academic performance is declining.
- Repeated absences are present.

**WHAT NEXT?**
- Contact parent/guardian.
- Talk to the student.
- Provide academic support.
- Monitor attendance.
- Schedule a follow-up.

## Privacy & Security

- Do not commit real student personal data to GitHub.
- Use anonymized/sample data for demonstrations.
- Never commit passwords, API keys, or database credentials.
- Keep `.env` files out of the repository.
- Use role-based access so users only see appropriate information.

## Expected Impact

DropoutGuard aims to:
- Identify students at risk earlier.
- Support timely teacher intervention.
- Reduce delayed dropout detection.
- Help teachers focus attention on students who need support.
- Provide understandable reasons instead of only a risk score.
- Support continuous monitoring of student progress.

### Impact Flow

```text
Early Identification
        ↓
Timely Intervention
        ↓
Continuous Monitoring
        ↓
Better Student Support
        ↓
Reduced Dropout Risk
```

## Future Scope

- Direct integration with school MIS systems
- Automated notifications to teachers/parents
- More historical student data
- Improved model training with real-world datasets
- Multilingual support
- Mobile application
- Advanced analytics for school administrators
- Periodic automatic risk updates

## References

- UNICEF – Building a predictive early warning system for school dropout in India  
  https://www.unicef.org/digitaleducation/stories/building-predictive-early-warning-system-school-dropout-india

- UNESCO – Early warning systems for school dropout prevention  
  https://www.unesco.org/en/articles/early-warning-systems-school-dropout-prevention-latin-america-and-caribbean

- World Bank – Predicting school dropout with administrative data  
  https://documents.worldbank.org/en/publication/documents-reports/documentdetail/273541499700395624

- Scikit-learn – RandomForestClassifier Documentation  
  https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.RandomForestClassifier.html

## Project Disclosure

> This is an original hackathon prototype inspired by existing research and approaches in educational early-warning systems. DropoutGuard combines trend-based dropout risk prediction with a **“WHY + WHAT NEXT?”** intervention layer and role-based dashboards for teachers, students, and parents/guardians.

## Team

**Project:** DropoutGuard – AI Early Warning & Intervention System

Add your team members here:

- Team Member 1
- Team Member 2
- Team Member 3
- Team Member 4

## License

This project was created as a hackathon/academic prototype.
