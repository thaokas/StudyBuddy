package com.studybuddy.repository;

import com.studybuddy.entity.ReminderSettings;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface ReminderSettingsRepository extends JpaRepository<ReminderSettings, String> {
}
